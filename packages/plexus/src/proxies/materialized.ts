import {
  type AllowedYValue,
  documentDisclosureSymbol,
  GenericRecordSchema,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  isProxyEntity,
  LegitimateSchema,
  type ModelConstructor,
  type ModelType,
  ParentReference,
  referenceSymbol,
  type ReferenceTuple,
  requestAdoptionSymbol,
  requestOrphanizationSymbol,
  type Storageable
} from "../proxy-runtime-types";
import * as Y from "yjs";
import invariant from "tiny-invariant";
import { trackAccess, trackModification } from "../tracking";
import { clone } from "../clone";
import { deref } from "../deref";
import { isModelType, maybeReference, maybeTransacting } from "../utils";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { currentlyEmancipating, emancipateChild } from "../utils/emancipateChild";

export type MaterializedProxyTarget<State extends LegitimateSchema<State>, Name extends string> = {
  target: ModelType<State, Name>;
  doc: Y.Doc;
  schema: GenericRecordSchema;
  localReference: ReferenceTuple;
  constructor: ModelConstructor<State, Name>;
  entityId: string;
  type: string;
  fieldMap: Y.Map<Storageable>;
};
export const buildMaterializedProxyHandler = <State extends LegitimateSchema<State>, Name extends string>(
  { target, doc, schema, localReference, constructor, entityId, type, fieldMap }: MaterializedProxyTarget<State, Name>,
  possibleTracker?: ModelType<State, Name>
) => {
  // minor hack for autoref
  let tracker: ModelType<State, Name> = possibleTracker as ModelType<State, Name>;
  const selfTarget = Object.defineProperties(
    {},
    {
      ...Object.fromEntries(
        Object.entries(schema).map(([key]) => [
          key,
          {
            enumerable: true,
            configurable: false,
            get() {
              return self[key];
            },
            set(value) {
              // @ts-expect-error
              self[key] = value;
            }
          } satisfies PropertyDescriptor
        ])
      ),
      uuid: {
        enumerable: false,
        configurable: false,
        get() {
          return null;
        }
      },
      [isProxyEntity]: {
        enumerable: false,
        configurable: false,
        value: true
      },
      parent: {
        enumerable: false,
        configurable: false,
        get() {
          return null;
        }
      }
    }
  );
  const ownKeys = Reflect.ownKeys(selfTarget);
  Reflect.setPrototypeOf(selfTarget, constructor.prototype);
  fieldMap.observe((event) => {
    for (const key of event.keysChanged) {
      trackModification(tracker, key);
    }
  });

  const informAdoption = (newParent: ModelType<{}, string>, field: string, extraFieldMetadata?: string) => {
    const currentParent = (fieldMap as Y.Map<any> as Y.Map<ParentReference>).get(YJS_GLOBALS.modelMetadataParent);
    const reference = newParent[referenceSymbol](doc);
    if (
      currentParent &&
      currentParent[0] === reference[0] &&
      currentParent[1] === field &&
      currentParent[2] === extraFieldMetadata
    ) {
      return;
    }
    maybeTransacting(doc, () => {
      trackModification(tracker, "parent");
      (fieldMap as Y.Map<any> as Y.Map<ParentReference>).set(
        YJS_GLOBALS.modelMetadataParent,
        extraFieldMetadata ? [reference[0], field, extraFieldMetadata] : [reference[0], field]
      );
    });
  };

  const informOrphanization = () => {
    const currentParent = fieldMap.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
    if (currentParent) {
      maybeTransacting(doc, () => {
        trackModification(tracker, "parent");
        // it is VERY important to alter fieldMap first to avoid cyclic processing
        fieldMap.delete(YJS_GLOBALS.modelMetadataParent);
      });
    }
  };

  const self = new Proxy(Object.seal(selfTarget), {
    get(_, key) {
      switch (key) {
        case isProxyEntity:
          return true;
        case documentDisclosureSymbol:
          return () => ({ doc });
        case informAdoptionSymbol:
          return informAdoption;
        case informOrphanizationSymbol:
          return informOrphanization;
        case requestAdoptionSymbol:
          return (newParent: ModelType<{}, string>, field: string, extraFieldMetadata?: string) => {
            // @ts-expect-error
            if (currentlyEmancipating.has(tracker)) {
              informAdoption(newParent, field, extraFieldMetadata);
            } else {
              maybeTransacting(doc, () => {
                const currentParent = fieldMap.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
                const reference = newParent[referenceSymbol](doc);
                (fieldMap as Y.Map<any> as Y.Map<ParentReference>).delete(YJS_GLOBALS.modelMetadataParent);
                if (currentParent) {
                  // @ts-expect-error
                  emancipateChild(doc, tracker, currentParent);
                }
                (fieldMap as Y.Map<any> as Y.Map<ParentReference>).set(
                  YJS_GLOBALS.modelMetadataParent,
                  extraFieldMetadata ? [reference[0], field, extraFieldMetadata] : [reference[0], field]
                );
                trackModification(tracker, "parent");
              });
            }
          };
        case requestOrphanizationSymbol:
          return () => {
            // @ts-expect-error
            if (currentlyEmancipating.has(tracker)) {
              informOrphanization();
            } else {
              const currentParent = fieldMap.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
              if (currentParent) {
                maybeTransacting(doc, () => {
                  // it is VERY important to alter fieldMap first to avoid cyclic processing
                  fieldMap.delete(YJS_GLOBALS.modelMetadataParent);
                  // @ts-expect-error
                  emancipateChild(doc, tracker, currentParent);
                });
                trackModification(tracker, "parent");
              }
            }
          };
        case Symbol.toStringTag:
          return type; // Return the model class name
        case Symbol.hasInstance:
          return (instance: any) => {
            // Check if instance is of this model type
            return isModelType(instance) && instance[referenceSymbol] !== undefined;
          };
        case "constructor":
          return constructor;
        case "uuid":
          // Expose entity ID as uuid field for ease of use
          // Non-enumerable to maintain clean iteration behavior
          return entityId;
        case referenceSymbol:
          // REFERENCE TYPE SELECTION.
          // This allows entities to reference dependencies while maintaining project boundaries
          return (assertedDoc: Y.Doc) => {
            invariant(doc === assertedDoc, `document misalignment: expected different doc`);
            // we're explicitly using pre-materialized references so we will be able to directly compare them
            return localReference; // Cross-project reference tuple: [entityId, projectId]
          };
        case "parent":
          trackAccess(tracker, key);
          // PARENT GETTER: Returns the parent entity if this is a child
          const parentRef = fieldMap.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
          if (!parentRef) return null;
          return deref(doc, [parentRef[0]]);
        case "clone":
          // TRANSACTIONAL CLONE: Creates a new entity using constructor pattern
          // Handles cycles and deduplication via clone transaction mapping
          // note that we're using trackingPointer to provide proper notifications mechanics
          // @ts-expect-error
          return (newProps?: {}) => clone(tracker, newProps);
      }
      if (typeof key === "string" && Object.hasOwn(schema, key)) {
        // Specific field access on the main entity
        trackAccess(tracker, key);

        return schema[key] === "val" || schema[key] === "child-val"
          ? deref(doc, fieldMap.get(key) as AllowedYValue)
          : target[key];
      }

      // Note: Symbol.iterator and Symbol.isConcatSpreadable don't make sense for model objects
      // as they're not iterable collections
      return Object.prototype[key];
    },
    set(_, elementKey, value) {
      // READONLY DEPENDENCY ENFORCEMENT:
      // Only entities from the root project can be modified
      // Dependency entities are immutable from this document's perspective
      if (typeof elementKey === "string") {
        const keyType = schema[elementKey];
        if (keyType === "val" || keyType === "child-val") {
          const oldValue = fieldMap.get(elementKey);
          if (oldValue === value) {
            return true;
          }
          // Handle parent tracking for child-val fields
          if (keyType === "child-val") {
            if (oldValue) {
              deref(doc, oldValue as any as ReferenceTuple)?.[informOrphanizationSymbol]();
            }
            value?.[requestOrphanizationSymbol]?.();
          }
          trackModification(tracker, elementKey);
          fieldMap.set(elementKey, maybeReference(value, doc));
          if (keyType === "child-val") {
            value?.[informAdoptionSymbol]?.(tracker, elementKey);
          }
          return true;
        }
        invariant(!keyType, "cannot directly set complex type");
      }
      console.warn(
        `cannot set property Symbol(${elementKey.toString()}) of ${type} as only string properties are supported`
      );
      return false;
    },
    has(_, key) {
      if (key === referenceSymbol || key === "uuid" || key === isProxyEntity || key === "parent") {
        return true;
      }
      if (typeof key === "symbol") {
        return false;
      }
      return Object.hasOwn(schema, key);
    },
    defineProperty() {
      return false;
    },
    ownKeys(_) {
      return ownKeys;
    },
    getPrototypeOf() {
      return constructor.prototype;
    }
  }) as any as ModelType<State, Name>;
  tracker ??= self;
  return self;
};
