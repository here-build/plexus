/* eslint-disable no-console,@typescript-eslint/no-empty-object-type */
/**
 * Contagious Proxy Runtime - Universal CRDT for Typed Object Models
 *
 * This system creates objects that exist in quantum superposition:
 * - EPHEMERAL: Local objects with full functionality, not synced
 * - MATERIALIZED: Same objects, now synced to YJS and shared across clients
 *
 * The "contagion" happens when ephemeral objects touch the YJS graph:
 * They automatically materialize (get entityId + sync) while preserving object identity.
 *
 * Key innovation: Same object reference throughout ephemeral → materialized transition.
 * No "upgrade" or replacement - the proxy behavior just changes internally.
 */

import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import * as Y from "yjs";
import {
  type AllowedYJSValue,
  type AllowedYValue,
  materializationSymbol,
  type ModelConstructor,
  ModelConstructorInit,
  ModelName,
  ModelSchema,
  ModelState,
  type ModelType,
  type ReferenceTuple,
  type Storageable
} from "./proxy-runtime-types.js";
import { YJS_GLOBALS } from "@dappsnap/plexus";
import { buildEphemeralProxy } from "./proxies/ephemeral";
import { buildMaterializedProxyHandler } from "./proxies/materialized";
import { buildSetProxy } from "./proxies/materialized-set";
import { buildArrayProxy } from "./proxies/materialized-array";
import { documentEntityCaches, entityClasses } from "./globals"; // For packages that use plexus, ProjectId should be string
import { curryMaybeReference } from "./utils";
import { buildRecordProxy } from "./proxies/materialized-map";
import { PlexusConstructor, PlexusModel } from "./PlexusModel"; // PROJECT DEPENDENCY ARCHITECTURE:

// PROJECT DEPENDENCY ARCHITECTURE:
// - ONE root project (editable, can create/modify entities)
// - MANY dependency projects (readonly, can only read entities)
// - Entities can reference across projects via cross-ref
// - Only root project entities can be mutated

// Model class factory
export function buildModelClass<T extends PlexusModel>(
  typeName: string,
  schema: ModelSchema<ModelState<T>>
): ModelConstructor<ModelState<T>, ModelName<T>> {
  type Model = ModelType<ModelState<T>, ModelName<T>>;


  // force is needed to resolve cyclic dependencies in some edge cases
  const spawn = (entityId: string, doc: Y.Doc, internal__ephemeralExternalObject?: Model, __force?: boolean) => {
    const boundMaybeReference = curryMaybeReference(doc);
    const localReference: ReferenceTuple = [entityId];
    const cached = documentEntityCaches.get(doc).get(entityId)?.deref();
    if (cached && !__force) {
      return cached as any as Model;
    }

    /* we need to explicitly initialize fields with proper types before using. otherwise sync protocol will break */
    const modelEntity = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
    let yprojectObjectInstanceFields = modelEntity.get(entityId);
    if (!yprojectObjectInstanceFields) {
      yprojectObjectInstanceFields = new Y.Map();
      modelEntity.set(entityId, yprojectObjectInstanceFields);
      yprojectObjectInstanceFields.set(YJS_GLOBALS.modelMetadataType, typeName);
      for (const [fieldName, fieldType] of Object.entries(schema)) {
        switch (fieldType) {
          case "set":
          case "child-set":
          case "list":
          case "child-list":
            if (!yprojectObjectInstanceFields.has(fieldName)) {
              // @ts-expect-error bool array issue
              yprojectObjectInstanceFields.set(fieldName, Y.Array.from<AllowedYJSValue>([]));
            }
            break;
          case "record":
          case "child-record":
            if (!yprojectObjectInstanceFields.has(fieldName)) {
              // @ts-expect-error bool array issue
              yprojectObjectInstanceFields.set(fieldName, new Y.Map());
            }
        }
      }
    } else {
      const type = modelEntity.get(entityId)!.get(YJS_GLOBALS.modelMetadataType) as string;
      invariant(type === typeName, `spawn type mismatch, ${type} !== ${typeName}`);
    }
    // we need to use proxy reference in target so we're doing JS black magic again
    let target = {} as any;

    const proxy = buildMaterializedProxyHandler(
      {
        target,
        doc,
        schema,
        localReference,
        constructor: ModelConstructor,
        entityId,
        type: typeName,
        fieldMap: yprojectObjectInstanceFields
      },
      internal__ephemeralExternalObject
    );

    // COLLECTION PROXY FACTORY & CACHE
    //
    // Each collection field (maps/arrays) gets its own proxy that:
    // 1. Wraps YJS Map/Array with native JavaScript interface
    // 2. Translates operations: obj[key]=val → yMap.set(key,val), arr.push() → yArray.push()
    // 3. Maintains object identity: repeated access to entity.children returns SAME proxy
    //
    // Schema → Proxy type mapping:
    // - "val-map"  → Proxy wrapping Y.Map<primitive>    (Object interface)
    // - "ref-map"  → Proxy wrapping Y.Map<Reference>    (Object interface)
    // - "val-list" → Proxy wrapping Y.Array<primitive>  (Array interface)
    // - "ref-list" → Proxy wrapping Y.Array<Reference>  (Array interface)

    Object.assign(
      target,
      Object.fromEntries(
        Object.entries(schema).map(([key, type]) => {
          switch (type) {
            case "child-list":
            case "list": {
              // REFERENCE LIST: Array of entity pointers
              // Get or create YJS Array for this field
              let list = yprojectObjectInstanceFields.get(key) as Y.Array<AllowedYValue> | undefined;
              if (!list) {
                list = new Y.Array();
                yprojectObjectInstanceFields.set(key, list);
              }
              if (internal__ephemeralExternalObject) {
                internal__ephemeralExternalObject[key]![materializationSymbol](list, boundMaybeReference);
                return [key, internal__ephemeralExternalObject[key]];
              }

              return [
                key,
                buildArrayProxy({
                  list,
                  // @ts-expect-error
                  owner: proxy,
                  boundMaybeReference,
                  ownerEntityId: entityId,
                  fieldName: key,
                  isChildField: type === "child-list"
                })
              ];
            }
            case "child-record":
            case "record": {
              let map = yprojectObjectInstanceFields.get(key) as Y.Map<AllowedYValue> | undefined;
              if (!map) {
                map = new Y.Map();
                yprojectObjectInstanceFields.set(key, map);
              }
              if (internal__ephemeralExternalObject) {
                internal__ephemeralExternalObject[key]![materializationSymbol](map, boundMaybeReference);
                return [key, internal__ephemeralExternalObject[key]];
              }
              return [
                key,
                buildRecordProxy({
                  boundMaybeReference,
                  map,
                  // @ts-expect-error
                  owner: proxy,
                  ownerEntityId: entityId,
                  fieldName: key,
                  isChildField: type === "child-record"
                })
              ];
            }
            case "child-set":
            case "set": {
              // Sets are small collections (params, states) backed by YJS Array
              // Present Record<string, T> interface but use array storage + includes()
              let underlyingArray = yprojectObjectInstanceFields.get(key) as Y.Array<AllowedYValue> | undefined;
              if (!underlyingArray) {
                underlyingArray = new Y.Array();
                yprojectObjectInstanceFields.set(key, underlyingArray);
              }
              if (internal__ephemeralExternalObject) {
                internal__ephemeralExternalObject[key]![materializationSymbol](underlyingArray, boundMaybeReference);
                return [key, internal__ephemeralExternalObject[key]];
              }

              return [
                key,
                buildSetProxy({
                  list: underlyingArray,
                  boundMaybeReference,
                  // @ts-expect-error
                  owner: proxy,
                  ownerEntityId: entityId,
                  fieldName: key,
                  isChildField: type === "child-set"
                })
              ];
            }
            default:
              return [key, null];
          }
        })
      )
    );
    if (!internal__ephemeralExternalObject) {
      documentEntityCaches.get(doc).set(entityId, new WeakRef(proxy as any as PlexusModel));
    }
    return proxy;
  };

  const ModelConstructor = new Proxy(
    Object.defineProperties(
      function ModelConstructorProxyTarget(
        this: Model,
        initialState: ModelConstructorInit<ModelState<T>, ModelName<T>>,
        internal__proto: Model
      ) {
        const entityId = nanoid();

        // QUANTUM SUPERPOSITION HANDLER:
        // This proxy exists in two states simultaneously:
        // - BEFORE materialization: Acts on local `target` data
        // - AFTER materialization: Forwards everything to YJS-synced `manifestedState` (yet external pointer is still ephemeralModel)
        // Same object reference, different behavior based on internal state.
        return buildEphemeralProxy({
          target: initialState,
          manifestedState: undefined,
          schema,
          localReference: [entityId],
          constructor: ModelConstructor,
          entityId,
          type: typeName,
          spawn
        });
      },
      { name: { value: `${typeName}Model` } }
    ) as any as ModelConstructor<ModelState<T>, ModelName<T>>,
    {
      get(target, key) {
        switch (key) {
          case "__type":
            return typeName;
          case "schema":
            return schema;
          case "spawn":
            return spawn;
          case "name":
            return typeName;
          default:
            return Reflect.get(target, key);
        }
      },
      construct(target, [initialState], newTarget) {
        // @ts-expect-error using internal api
        return new target(initialState, newTarget);
      }
    }
  );

  entityClasses.set(typeName, ModelConstructor as any as PlexusConstructor);

  return ModelConstructor;
}
