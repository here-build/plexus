import {
  type AllowedYJSValue,
  type AllowedYValue,
  GenericRecordSchema,
  informOrphanizationSymbol,
  informAdoptionSymbol,
  isProxyEntity,
  LegitimateSchema,
  type ModelConstructor,
  ModelConstructorInit,
  type ModelPattern,
  type ModelType,
  ParentReference,
  documentDisclosureSymbol,
  referenceSymbol,
  type ReferenceTuple,
  requestOrphanizationSymbol,
  requestAdoptionSymbol,
  type Storageable
} from "../proxy-runtime-types";
import * as Y from "yjs";
import { ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import invariant from "tiny-invariant";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { curryMaybeReference, definitelyReference, maybeTransacting, never } from "../utils";
import { clone } from "../clone";
import { documentEntityCaches } from "../globals";
import { buildSetProxy } from "./materialized-set";
import { buildRecordProxy } from "./materialized-map";
import { buildArrayProxy } from "./materialized-array";
import { legitimateRootDocs } from "../load";

export type EphemeralProxyTarget<State extends LegitimateSchema<State>, Name extends string> = {
  target: ModelConstructorInit<State, Name>;
  manifestedState?: ModelType<State, Name>;
  schema: GenericRecordSchema;
  localReference: ReferenceTuple;
  constructor: ModelConstructor<State, Name>;
  entityId: string;
  type: string;
  spawn: (
    entityId: string,
    doc: Y.Doc,
    internal__ephemeralExternalObject?: ModelType<State, Name>,
    __force?: boolean
  ) => ModelType<State, Name>;
};

export const buildEphemeralProxy = <State extends LegitimateSchema<State>, Name extends string>({
  schema,
  spawn,
  constructor,
  entityId,
  localReference,
  manifestedState,
  target: originalTarget,
  type
}: EphemeralProxyTarget<State, Name>) => {
  let isManifested = false;
  let ephemeralParent: ModelType<{}, string> | null = null; // Track parent for ephemeral entities
  let ephemeralParentKey: string | null = null; // Track parent for ephemeral entities
  let extraParentMetadata: string | undefined;

  const orphanize = () => {
    ephemeralParent = null;
    ephemeralParentKey = null;
    extraParentMetadata = undefined;
  }

  const emancipate = () => {
    if (ephemeralParent) {
      switch (ephemeralParent.constructor.schema[ephemeralParentKey!]) {
        case "child-val":
          ephemeralParent[ephemeralParentKey!] = null;
          break;
        case "child-set":
          ephemeralParent[ephemeralParentKey!].delete(self);
          break;
        case "child-list":
          const childIndex = (ephemeralParent[ephemeralParentKey!] as any[]).indexOf(self);
          if (childIndex !== -1) {
            (ephemeralParent[ephemeralParentKey!] as any[]).splice(childIndex, 1);
          }
          break;
        case "child-record":
          delete ephemeralParent[ephemeralParentKey!][extraParentMetadata!];
          break;
      }
    }
  }

  const getAdopted = (newParent: ModelPattern, field: string, extraMetadata?: string) => {
    ephemeralParent = newParent as ModelType<{}, string>;
    ephemeralParentKey = field;
    extraParentMetadata = extraMetadata;
  }

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

  Reflect.setPrototypeOf(selfTarget, constructor);
  const self = new Proxy(Object.seal(selfTarget), {
    // eslint-disable-next-line sonarjs/function-return-type
    get(_, key) {
      switch (key) {
        case "constructor":
          return constructor;
        case "uuid":
          return entityId;
        case isProxyEntity:
          return true;
      }
      // POST-MATERIALIZATION: Forward all access to the YJS-synced version except ones that are clear
      if (manifestedState) {
        return Reflect.get(manifestedState, key);
      }
      switch (key) {
        case referenceSymbol:
          return function reference(this: ModelType<State, Name>, doc: Y.Doc): ReferenceTuple {
            invariant(legitimateRootDocs.has(doc), "passed doc is not registered as legitimate Plexus root");
            // this is needed explicitly in that manner for cyclic dependencies.
            // It will never cause cross-doc issues as we only materialize root doc entities.
            // Lucky for us, Plexus is doing not structural but reference equivalence - so we can safely assume that returning pointer will do nothing wrong.
            if (isManifested) {
              return localReference;
            }
            isManifested = true;
            const boundMaybeReference = curryMaybeReference(doc);
            // eslint-disable-next-line sonarjs/no-nested-functions
            return maybeTransacting(doc, () => {
              const yprojectObjectInstances = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
              let yprojectObjectInstanceFields = yprojectObjectInstances.get(entityId);
              if (!yprojectObjectInstanceFields) {
                yprojectObjectInstanceFields = new Y.Map<Storageable>();
                yprojectObjectInstances.set(entityId, yprojectObjectInstanceFields);
                yprojectObjectInstanceFields.set(YJS_GLOBALS.modelMetadataType, type);
                if (ephemeralParent) {
                  const parentReference = ephemeralParent[referenceSymbol](doc);
                  (yprojectObjectInstanceFields as Y.Map<any> as Y.Map<ParentReference>).set(
                    YJS_GLOBALS.modelMetadataParent,
                    extraParentMetadata
                      ? [parentReference[0], ephemeralParentKey!, extraParentMetadata]
                      : [parentReference[0], ephemeralParentKey!]
                  );
                }
              }
              for (const [schemaKey, type] of Object.entries(schema)) {
                switch (type) {
                  case "val":
                  case "child-val":
                    yprojectObjectInstanceFields.set(
                      schemaKey,
                      boundMaybeReference(target[schemaKey] as AllowedYJSValue)
                    );
                    break;
                  case "list":
                  case "child-list":
                    yprojectObjectInstanceFields.set(
                      schemaKey,
                      // @ts-expect-error todo yjs Array.from not supporting boolean
                      Y.Array.from(
                        // @ts-expect-error todo yjs Array.from not supporting boolean
                        // Convert sparse arrays to dense arrays (holes become null)
                        Array.from<AllowedYJSValue, AllowedYValue>(target[schemaKey], boundMaybeReference)
                      )
                    );
                    break;
                  case "record":
                  case "child-record":
                    yprojectObjectInstanceFields.set(
                      schemaKey,
                      new Y.Map<AllowedYValue | null>(
                        Object.entries(target[schemaKey] as Record<string, AllowedYJSValue>).map(([recordKey, val]) => [
                          recordKey,
                          boundMaybeReference(val)
                        ])
                      )
                    );
                    break;
                  case "set":
                  case "child-set":
                    yprojectObjectInstanceFields.set(
                      schemaKey,
                      // @ts-expect-error todo yjs Array.from not supporting boolean
                      Y.Array.from(
                        // Convert Set to array while mapping references
                        // @ts-expect-error todo yjs Array.from not supporting boolean
                        Array.from(target[schemaKey], boundMaybeReference)
                      )
                    );
                    break;
                  default:
                    never(type);
                }
              }

              // IDENTITY PRESERVATION MINDFUCK:
              //
              // This ephemeral proxy is about to become the canonical reference for this entity.
              // Here's what happens:
              //
              // 1. We create a YJS-backed proxy via spawn() (target[ManifestedStateSymbol)
              // 2. We cache THIS ephemeral proxy (not the materialized one) as canonical
              // 3. This proxy forwards all behavior to target[ManifestedStateSymbol via the get() handler above
              // 4. Future spawn() calls for this target[EntityIDSymbol return THIS SAME ephemeral proxy
              // 5. Result: Perfect object identity - ephemeral === materialized references
              //
              // The proxy becomes a pointer to its own materialized form while remaining itself.
              // Existential crisis: The object IS the reference TO itself.
              const entityCache = documentEntityCaches.get(doc);
              if (!entityCache.has(entityId)) {
                manifestedState ??= spawn(entityId, doc, self, true);
                if (ephemeralParent) {
                  manifestedState[informAdoptionSymbol]!(ephemeralParent, ephemeralParentKey!, extraParentMetadata);
                }
                entityCache.set(entityId, new WeakRef(self)); // Cache SELF, not spawn result
              }
              return localReference;
            });
          };
        case "parent":
          trackAccess(self, key);
          return ephemeralParent;
        case "clone":
          // EPHEMERAL CLONE: Creates a new ephemeral entity with same structure and field values
          return (newProps?: Partial<State>) => clone(self, newProps);
        case informAdoptionSymbol:
          return (newParent: ModelPattern, field: string, extraMetadata?: string) => {
            if (
              ephemeralParent === newParent &&
              ephemeralParentKey === field &&
              extraMetadata === extraParentMetadata
            ) {
              return;
            }
            const referenceDisclosure = newParent?.[documentDisclosureSymbol]?.();
            if (referenceDisclosure) {
              self[referenceSymbol](referenceDisclosure.doc);
              return self[informAdoptionSymbol](newParent, field, extraMetadata);
            }
            getAdopted(newParent, field, extraMetadata);
            trackModification(self, "parent");
          }
        case requestAdoptionSymbol:
          return (newParent: ModelPattern, field: string, extraMetadata?: string) => {
            if (
              ephemeralParent === newParent &&
              ephemeralParentKey === field &&
              extraMetadata === extraParentMetadata
            ) {
              return;
            }
            const referenceDisclosure = newParent?.[documentDisclosureSymbol]?.();
            if (referenceDisclosure) {
              self[referenceSymbol](referenceDisclosure.doc);
              return self[requestAdoptionSymbol](newParent, field, extraMetadata);
            }
            emancipate();
            orphanize();
            getAdopted(newParent, field, extraMetadata);
            trackModification(self, "parent");
          };
        case informOrphanizationSymbol:
          return () => {
            orphanize();
            trackModification(self, "parent");
          };
        case requestOrphanizationSymbol:
          return () => {
            emancipate();
            orphanize();
            trackModification(self, "parent");
          };
        case Symbol.toStringTag:
          return type; // Return the model class name
      }
      if (Object.hasOwn(schema, key) && typeof key === "string") {
        trackAccess(self, key);
        return target[key];
      }
      // Handle well-known symbols for ephemeral model root
      if (key in Object.prototype) {
        return target[key as keyof typeof target];
      }
      return;
    },

    // eslint-disable-next-line sonarjs/cognitive-complexity
    set(_, elementKey, value) {
      if (manifestedState) {
        return Reflect.set(manifestedState, elementKey, value);
      }

      if (typeof elementKey === "symbol") {
        return false;
      }
      if (!Object.hasOwn(schema, elementKey)) {
        console.warn(`cannot set property ${elementKey.toString()} of ${type} as it is not declared in type schema`);
        return false;
      }
      invariant(
        schema[elementKey] === "val" || schema[elementKey] === "child-val",
        `cannot directly assign ${schema[elementKey]}-typed ${type}.${elementKey.toString()}; instead manipulate the existing object`
      );
      const disclosure = (value as ModelPattern | null)?.[documentDisclosureSymbol]?.();
      if (disclosure) {
        definitelyReference(self, disclosure.doc);
        return Reflect.set(self, elementKey, value);
      }
      if (schema[elementKey] === "child-val") {
        value?.[requestOrphanizationSymbol]?.();
      }
      target[elementKey] = value;
      // in other branch we are doing tracking with manifested state
      trackModification(self, elementKey);

      if (schema[elementKey] === "child-val") {
        value?.[informAdoptionSymbol]?.(self, elementKey);
      }
      return true;
    },

    deleteProperty(_, key) {
      if (manifestedState) {
        return Reflect.deleteProperty(manifestedState, key);
      }
      if (typeof key === "symbol") {
        return false;
      }
      if (schema[key] === "val" || schema[key] === "child-val") {
        trackModification(self, key);
        trackModification(self, ACCESS_INDICES_SET_SYMBOL);

        delete target[key as keyof typeof target];
        return true;
      }
      return false;
    },
    defineProperty() {
      return false;
    },
    has(_, key) {
      if (
        key === isProxyEntity ||
        key === referenceSymbol ||
        key === documentDisclosureSymbol ||
        key === informAdoptionSymbol ||
        key === informOrphanizationSymbol ||
        key === "uuid" ||
        key === "parent"
      ) {
        return true;
      }
      if (typeof key === "symbol") {
        return false;
      }
      return Object.hasOwn(schema, key);
    },
    ownKeys(_) {
      return ownKeys;
    }
  }) as any as ModelType<State, Name>;
  const target = Object.fromEntries(
    Object.entries(schema).map(([key, type]) => {
      const value = originalTarget[key];
      switch (type) {
        case "val":
          return [key, value];
        case "child-val":
          value?.[requestAdoptionSymbol]?.(self, key);
          return [key, value];
        case "set":
        case "child-set":
          if (type === "child-set" && value) {
            for (const entity of value) {
              entity?.[requestAdoptionSymbol]?.(self, key);
            }
          }
          return [
            key,
            buildSetProxy(
              { owner: self, ownerEntityId: entityId, fieldName: key, isChildField: type === "child-set" },
              value ?? undefined
            )
          ];
        case "record":
        case "child-record":
          if (type === "child-record" && value) {
            for (const [subkey, entity] of Object.entries(value)) {
              entity?.[requestAdoptionSymbol]?.(self, key, subkey);
            }
          }
          return [
            key,
            buildRecordProxy(
              { owner: self, ownerEntityId: entityId, fieldName: key, isChildField: type === "child-record" },
              value ?? undefined
            )
          ];
        case "list":
        case "child-list":
          if (type === "child-list" && value) {
            for (const entity of value) {
              entity?.[requestAdoptionSymbol]?.(self, key);
            }
          }
          return [
            key,
            buildArrayProxy(
              { owner: self, ownerEntityId: entityId, fieldName: key, isChildField: type === "child-list" },
              value ?? undefined
            )
          ];
      }
    })
  );

  return self;
};
