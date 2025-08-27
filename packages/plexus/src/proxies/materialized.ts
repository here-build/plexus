import {
  type AllowedYValue,
  GenericRecordSchema,
  isProxyEntity,
  LegitimateSchema,
  type ModelConstructor,
  type ModelType,
  referenceDisclosureSymbol,
  referenceSymbol,
  type ReferenceTuple,
  type Storageable
} from "../proxy-runtime-types";
import * as Y from "yjs";
import invariant from "tiny-invariant";
import { ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { clone } from "../clone";
import { deref } from "../deref";
import { isModelType, maybeReference } from "../utils";

export type MaterializedProxyTarget<State extends LegitimateSchema<State>, Name extends string> = {
  target: ModelType<State, Name>;
  doc: Y.Doc;
  projectId: string;
  schema: GenericRecordSchema;
  localReference: ReferenceTuple;
  globalReference: ReferenceTuple;
  constructor: ModelConstructor<State, Name>;
  entityId: string;
  type: string;
  fieldMap: Y.Map<Storageable>;
};
export const buildMaterializedProxyHandler = <State extends LegitimateSchema<State>, Name extends string>(
  {
    target,
    doc,
    projectId,
    schema,
    localReference,
    globalReference,
    constructor,
    entityId,
    type,
    fieldMap
  }: MaterializedProxyTarget<State, Name>,
  possibleTracker?: ModelType<State, Name>
) => {
  // minor hack for autoref
  let tracker: ModelType<State, Name> = possibleTracker as ModelType<State, Name>;
  const ownKeys = [...Object.keys(schema), "uuid", isProxyEntity];
  const selfTarget = Object.seal({
    ...Object.fromEntries(
      Object.entries(schema).map(([key]) => [
        key,
        {
          enumerable: true,
          configurable: false,
          get() {
            return self[key]
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
    }
  })
  Reflect.setPrototypeOf(selfTarget, constructor);
  fieldMap.observe((event) => {
    for (const key of event.keysChanged) {
      trackModification(possibleTracker ?? self, key);
    }
  })
  const self = new Proxy(Object.seal(selfTarget), {
    get(_, key) {
      if (key === isProxyEntity) return true;
      if (key === referenceDisclosureSymbol) {
        return () => ({
          projectId,
          doc
        });
      }
      if (key === "constructor") {
        return constructor;
      }
      if (key === "uuid") {
        // Expose entity ID as uuid field for DappSnap compatibility
        // Non-enumerable to maintain clean iteration behavior
        return entityId;
      }
      if (key === referenceSymbol) {
        // REFERENCE TYPE SELECTION.
        // This allows entities to reference dependencies while maintaining project boundaries
        return (assertedProjectId: string, assertedDoc: Y.Doc) => {
          const docProjectId = doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.projectId);
          const assertedDocProjectId = doc
            .getMap<string>(YJS_GLOBALS.metadataMap)
            .get(YJS_GLOBALS.metadataMapFields.projectId);

          invariant(
            doc === assertedDoc,
            `document misalignment: expected project<${docProjectId}> doc, got project<${assertedDocProjectId}> doc`
          );
          // we're explicitly using pre-materialized references so we will be able to directly compare them
          return projectId === assertedProjectId
            ? localReference // Local reference tuple: [entityId]
            : globalReference; // Cross-project reference tuple: [entityId, projectId]
        };
      }
      if (key === "clone") {
        // TRANSACTIONAL CLONE: Creates a new entity using constructor pattern
        // Handles cycles and deduplication via clone transaction mapping
        // note that we're using trackingPointer to provide proper notifications mechanics
        return (newProps?: {}) => clone(tracker, newProps);
      }
      if (typeof key === "string" && Object.hasOwn(schema, key)) {
        // Specific field access on the main entity
        trackAccess(tracker, key);

        return schema[key] === "val" || schema[key] === "child-val"
          ? deref(doc, fieldMap.get(key) as AllowedYValue)
          : target[key];
      }

      // Handle well-known symbols for model root
      if (typeof key === "symbol") {
        switch (key) {
          case Symbol.toStringTag:
            return type; // Return the model class name
          case Symbol.hasInstance:
            return (instance: any) => {
              // Check if instance is of this model type
              return isModelType(instance) && instance[referenceSymbol] !== undefined;
            };
          // Note: Symbol.iterator and Symbol.isConcatSpreadable don't make sense for model objects
          // as they're not iterable collections
        }
      }

      return Object.prototype[key];
    },
    set(_, elementKey, value) {
      // READONLY DEPENDENCY ENFORCEMENT:
      // Only entities from the root project can be modified
      // Dependency entities are immutable from this document's perspective
      const docProjectId = doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.projectId);
      if (projectId !== docProjectId) {
        console.warn(`cannot set property ${elementKey.toString()} of ${type} as it's readonly dependency reference`);
        return false; // Silently reject writes to readonly dependencies
      }
      if (typeof elementKey === "string") {
        const keyType = schema[elementKey];
        if (keyType === "val" || keyType === "child-val") {
          trackModification(tracker, elementKey);
          fieldMap.set(elementKey, maybeReference(value, projectId, doc));
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
      if (key === referenceSymbol || key === "uuid" || key === isProxyEntity) {
        return true;
      }
      if (typeof key === "symbol") {
        return false;
      }
      trackAccess(tracker, ACCESS_INDICES_SET_SYMBOL);
      return Object.hasOwn(schema, key);
    },
    ownKeys(_) {
      return ownKeys;
    }
  }) as any as ModelType<State, Name>;
  tracker ??= self;
  return self;
};
