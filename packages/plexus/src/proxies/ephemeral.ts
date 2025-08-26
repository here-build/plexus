import {
  type AllowedYJSValue,
  type AllowedYValue,
  GenericRecordSchema,
  isProxyEntity,
  LegitimateSchema,
  type ModelConstructor,
  ModelConstructorInit,
  type ModelPattern,
  type ModelType,
  referenceDisclosureSymbol,
  ReferenceProjector,
  referenceSymbol,
  type ReferenceTuple,
  type Storageable
} from "../proxy-runtime-types";
import * as Y from "yjs";
import { ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import invariant from "tiny-invariant";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { curryMaybeReference, definitelyReference, never } from "../utils";
import { clone } from "../clone";
import { documentEntityCaches } from "../globals";
import { materializedSetProxyInit } from "./materialized-set";

export type EphemeralProxyTarget<State extends LegitimateSchema<State>, Name extends string> = {
  target: ModelConstructorInit<State, Name>;
  manifestedState?: ModelType<State, Name>;
  schema: GenericRecordSchema;
  localReference: ReferenceTuple;
  globalReference?: ReferenceTuple;
  constructor: ModelConstructor<State, Name>;
  entityId: string;
  type: string;
  spawn: (
    entityId: string,
    projectId: string,
    doc: Y.Doc,
    internal__ephemeralExternalObject?: ModelType<State, Name>
  ) => ModelType<State, Name>;
};
export const buildEphemeralProxy = <State extends LegitimateSchema<State>, Name extends string>({
  schema,
  spawn,
  constructor,
  entityId,
  globalReference,
  localReference,
  manifestedState,
  target: originalTarget,
  type
}: EphemeralProxyTarget<State, Name>) => {
  const target = Object.fromEntries(Object.entries(originalTarget).map(([key, value]) => {
    switch (schema[key]) {
      case "val":
      case "child-val":
        return [key, value]
      case "set":
      case "child-set":
        return [key, new Proxy({}, materializedSetProxyInit)]
      case "record":
      case "child-record":
        return [key, value ?? {}]
      case "list":
      case "child-list":
        return [key, value ?? []]
    }
  }))
  const self = new Proxy(Object.seal(Object.defineProperties(
    {},
    {
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
  ), {
    // eslint-disable-next-line sonarjs/function-return-type
    get(_, key) {
      if (key === isProxyEntity) return true;
      // POST-MATERIALIZATION: Forward all access to the YJS-synced version
      if (manifestedState) {
        return Reflect.get(manifestedState, key);
      }
      if (key === "constructor") {
        return constructor;
      }
      if (key === "uuid") {
        return entityId;
      }
      if (key === referenceSymbol) {
        return function reference(this: ModelType<State, Name>, projectId: string, doc: Y.Doc): ReferenceTuple {
          if (globalReference) {
            return projectId === globalReference[1] ? localReference : globalReference;
          }
          globalReference = [entityId, projectId];
          if (manifestedState) {
            return (manifestedState[referenceSymbol] as any as ReferenceProjector)(projectId, doc);
          }
          const boundMaybeReference = curryMaybeReference(projectId, doc);
          // eslint-disable-next-line sonarjs/no-nested-functions
          return doc.transact(() => {
            const docProjectId = doc
              .getMap<string>(YJS_GLOBALS.metadataMap)
              .get(YJS_GLOBALS.metadataMapFields.projectId);
            const prefix = projectId === docProjectId ? "" : `project:${projectId}:`;
            const yprojectObjectInstances = doc.getMap<Y.Map<Storageable>>(`${prefix}${YJS_GLOBALS.models}`);
            let yprojectObjectInstanceFields = yprojectObjectInstances.get(entityId);
            if (!yprojectObjectInstanceFields) {
              yprojectObjectInstanceFields = new Y.Map<Storageable>();
              yprojectObjectInstances.set(entityId, yprojectObjectInstanceFields);
            }
            const yprojectEntityType = doc.getMap<string>(`${prefix}${YJS_GLOBALS.modelTypes}`);

            yprojectEntityType.set(entityId, type);
            for (const [schemaKey, type] of Object.entries(schema) as [
              string,
              "val" | "list" | "record" | "set" | "child-val" | "child-list" | "child-record" | "child-set"
            ][]) {
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
                      Array.from<AllowedYJSValue, AllowedYValue>(target[schemaKey] ?? [], boundMaybeReference)
                    )
                  );
                  break;
                case "record":
                case "child-record":
                  yprojectObjectInstanceFields.set(
                    schemaKey,
                    new Y.Map<AllowedYValue | null>(
                      Object.entries((target[schemaKey] as Record<string, AllowedYJSValue> | null) ?? {}).map(
                        ([recordKey, val]) => [recordKey, boundMaybeReference(val)]
                      )
                    )
                  );
                  break;
                case "set":
                case "child-set":
                  yprojectObjectInstanceFields.set(
                    schemaKey,
                    // @ts-expect-error todo yjs Array.from not supporting boolean
                    Y.Array.from(
                      // @ts-expect-error todo yjs Array.from not supporting boolean
                      (target[schemaKey] as Set<AllowedYJSValue>).values().map(boundMaybeReference)
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
            const cacheKey = `${projectId}.${entityId}`;
            const entityCache = documentEntityCaches.get(doc);
            if (!entityCache.has(cacheKey)) {
              manifestedState ??= spawn(entityId, projectId, doc);
              entityCache.set(cacheKey, new WeakRef(self)); // Cache SELF, not spawn result
            }
            return projectId === docProjectId ? localReference : globalReference!;
          });
        };
      }
      if (key === "clone") {
        // EPHEMERAL CLONE: Creates a new ephemeral entity with same structure and field values
        return (newProps?: Partial<State>) => clone(self, newProps);
      }
      if (Object.hasOwn(schema, key) && typeof key === "string") {
        trackAccess(self, key);
        return target[key];
      }
      // Handle well-known symbols for ephemeral model root
      if (typeof key === "symbol") {
        switch (key) {
          case Symbol.toStringTag:
            return type; // Return the model class name
        }
      }
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
      const disclosure = (value as ModelPattern | null)?.[referenceDisclosureSymbol]?.();
      if (disclosure) {
        definitelyReference(self, disclosure.projectId, disclosure.doc);
        // @ts-expect-error proxy trickery
        self[elementKey] = value;
      } else {
        target[elementKey] = value;
        // in other branch we are doing tracking with manifested state
        trackModification(self, elementKey);
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
    has(_, key) {
      // "in" operator checks for field existence (ephemeral entity)
      if (Object.hasOwn(schema, key)) {
        trackAccess(self, key);
        return true;
      }
      return false;
    },
    ownKeys(_) {
      // ownKeys accesses all entity field names (ephemeral entity)
      // Include _ephemeralUuid if it exists to satisfy proxy invariants
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return [...Object.keys(schema), "uuid", isProxyEntity];
    },
    getPrototypeOf(_) {
      return constructor;
    },
    isExtensible(): boolean {
      return false;
    }
  }) as any as ModelType<State, Name>;
  return self;
};
