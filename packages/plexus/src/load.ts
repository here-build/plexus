import { AllowedYJSValue, isProxyEntity, ModelPattern, referenceSymbol, Storageable } from "./proxy-runtime-types";
import * as Y from "yjs";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { entityClasses } from "./globals";
import invariant from "tiny-invariant";
import { DefaultedMap, never } from "./utils";
import { clone } from "./clone";
import { deref } from "./deref";

class RestrictedSet extends Set<AllowedYJSValue> {
  add(): never {
    throw new Error("modifications are restricted for that entity");
  }

  delete(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
    throw new Error("modifications are restricted for that entity");
  }

  // convenience aliases used elsewhere in API shape
  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }
}

class RestrictedArray extends Array<AllowedYJSValue> {
  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
    throw new Error("modifications are restricted for that entity");
  }
}

class RestrictedRecord extends Object {
  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
    throw new Error("modifications are restricted for that entity");
  }
}

export const docDependencyResolverMap = new WeakMap<Y.Doc, (packageId: string, entityId: string) => ModelPattern>();
export const legitimateRootDocs = new WeakSet<Y.Doc>();

export function load<T extends ModelPattern>(doc: Y.Doc, dependencies: Record<string, Y.Doc> = {}): T {
  // initializing
  const cache = new DefaultedMap<string, Map<string, ModelPattern>>(() => new Map());

  const resolver = (entityId, packageId) => {
    const cachedEntity = cache.get(packageId).get(entityId);
    if (cachedEntity) {
      return cachedEntity;
    }

    const model = dependencies[packageId].getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(entityId);
    invariant(model, `cannot find model data for ${packageId}:${entityId}`);
    const type = model.get(YJS_GLOBALS.modelMetadataType) as string;
    const Constructor = entityClasses.get(type);
    invariant(Constructor, `cannot find model type ${type} for ${packageId}:${entityId}`);
    const proxyTarget = {} as T;

    const manifestation = new Proxy(proxyTarget, {
      get(target, key) {
        switch (key) {
          case "clone":
            return (newProperties?: Record<string, any>) => {
              // Clone the manifestation (not the raw proxyTarget snapshot)
              // @ts-expect-error generic types
              return clone(manifestation as any, newProperties);
            };
          case isProxyEntity:
            return true;
          case "constructor":
            return Constructor;
          case "uuid":
            return entityId;
          case referenceSymbol:
            return () => [entityId, packageId];
          default:
            return target[key];
        }
      },
      set() {
        return false;
      },
      defineProperty() {
        return false;
      },
      has(_, key) {
        return key === referenceSymbol || key === "uuid" || key === isProxyEntity || Reflect.has(proxyTarget, key);
      }
    });
    cache.get(packageId).set(entityId, manifestation);
    Object.assign(
      proxyTarget,
      Object.fromEntries(
        Object.entries(Constructor.schema).map(([key, type]) => {
          const target = model.get(key);
          switch (type) {
            case "val":
            case "child-val":
              return [key, Array.isArray(target) ? resolver(target[0], target[1] ?? packageId) : target];
            case "set":
            case "child-set":
              invariant(
                target instanceof Y.Array,
                `expected array at ${packageId}:${entityId}:${key}, got ${typeof target}`
              );
              const values = target
                .toArray()
                .map((val) => (Array.isArray(val) ? resolver(val[0], val[1] ?? packageId) : val));
              const base = new Set(values);
              Object.setPrototypeOf(base, RestrictedSet.prototype);
              return [key, Object.freeze(base as unknown as RestrictedSet)];
            case "list":
            case "child-list":
              invariant(
                target instanceof Y.Array,
                `expected array at ${packageId}:${entityId}:${key}, got ${typeof target}`
              );
              return [
                key,
                Object.freeze(
                  new RestrictedArray(
                    ...target.toArray().map((val) => (Array.isArray(val) ? resolver(val[0], val[1] ?? packageId) : val))
                  )
                )
              ];
            case "record":
            case "child-record":
              invariant(
                target instanceof Y.Map,
                `expected record at ${packageId}:${entityId}:${key}, got ${typeof target}`
              );
              const entries = Array.from(target.entries());
              return [
                key,
                Object.freeze(
                  new RestrictedRecord(
                    Object.fromEntries(
                      entries.map(([k, val]) => [k, Array.isArray(val) ? resolver(val[0], val[1] ?? packageId) : val])
                    )
                  )
                )
              ];
            default:
              never(type);
          }
        })
      )
    );
    return manifestation;
  };

  legitimateRootDocs.add(doc);
  docDependencyResolverMap.set(doc, resolver);

  doc.getMap(YJS_GLOBALS.models);
  const rootId = doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.root);
  invariant(rootId, "missing root model id");
  const root = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(rootId);
  invariant(root, "missing root model description");
  const rootType = root.get(YJS_GLOBALS.modelMetadataType) as string;
  const Constructor = entityClasses.get(rootType);
  invariant(Constructor, `missing constructor of ${rootType} for root entity`);
  return Constructor.spawn(rootId, doc) as any as T; // we're unable to validate types against tests anyway, sadly
}

/**
 * Load a specific entity by ID from a YJS document.
 * Wrapper around deref for single-document environments.
 * 
 * @param doc The YJS document containing the entity
 * @param entityId The ID of the entity to load
 * @returns The loaded entity or null if not found
 * 
 * @example
 * const user = loadEntity<UserType>(doc, userId);
 * const post = loadEntity<PostType>(doc, postId);
 */
export function loadEntity<T extends ModelPattern>(
  doc: Y.Doc,
  entityId: string
): T | null {
  try {
    // Create a reference tuple and deref it
    return deref(doc, [entityId]) as T;
  } catch (e) {
    // If deref throws (entity not found, missing type, etc.), return null
    return null;
  }
}
