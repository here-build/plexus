import { AllowedYJSValue, isProxyEntity, ModelPattern, referenceSymbol, Storageable } from "./proxy-runtime-types";
import * as Y from "yjs";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { entityClasses } from "./globals";
import invariant from "tiny-invariant";
import { DefaultedMap, never } from "./utils";

class RestrictedSet extends Set<AllowedYJSValue> {
  set(): never {
    throw new Error("modifications are restricted for that entity");
  }

  delete(): never {
    throw new Error("modifications are restricted for that entity");
  }

  assign(): never {
    throw new Error("modifications are restricted for that entity");
  }

  clear(): never {
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
    const model = dependencies[packageId].getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(entityId);
    const type = dependencies[packageId].getMap<string>(YJS_GLOBALS.modelTypes).get(entityId);
    invariant(model && type, `cannot find model data for ${packageId}:${entityId}`);
    const Constructor = entityClasses.get(type);
    invariant(Constructor, `cannot find model type ${type} for ${packageId}:${entityId}`);
    const proxyTarget = {} as ModelPattern;

    const manifestation = new Proxy(proxyTarget, {
      get(target, key) {
        switch (key) {
          case "clone":
            return {}; // todo
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
                Array.isArray(target),
                `expected array at ${packageId}:${entityId}:${key}, got ${typeof target}`
              );
              return [
                key,
                Object.freeze(
                  new RestrictedSet(
                    target.map((val) => (Array.isArray(val) ? resolver(val[0], val[1] ?? packageId) : val))
                  )
                )
              ];
            case "list":
            case "child-list":
              invariant(
                Array.isArray(target),
                `expected array at ${packageId}:${entityId}:${key}, got ${typeof target}`
              );
              return [
                key,
                Object.freeze(
                  new RestrictedArray(
                    ...target.map((val) => (Array.isArray(val) ? resolver(val[0], val[1] ?? packageId) : val))
                  )
                )
              ];
            case "record":
            case "child-record":
              invariant(
                typeof target === "object" && target !== null && !Array.isArray(target),
                `expected record at ${packageId}:${entityId}:${key}, got ${typeof target}`
              );
              return [
                key,
                Object.freeze(
                  new RestrictedRecord(
                    Object.entries(target).map(([key, val]) => [
                      key,
                      Array.isArray(val) ? resolver(val[0], val[1] ?? packageId) : val
                    ])
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
  doc.getMap(YJS_GLOBALS.modelTypes);
  const rootId = doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.root);
  invariant(rootId, "missing root model id")
  const root = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(rootId);
  const rootType = doc.getMap<string>(YJS_GLOBALS.modelTypes).get(rootId);
  invariant(root && rootType, "missing root model description")
  const Constructor = entityClasses.get(rootType);
  invariant(Constructor, `missing constructor of ${rootType} for root entity`);
  return Constructor.spawn(rootId, doc) as any as T; // we're unable to validate types against tests anyway, sadly
}
