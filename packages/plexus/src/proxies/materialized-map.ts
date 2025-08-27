import * as Y from "yjs";
import { AllowedYJSValue, AllowedYValue, materializationSymbol, ModelPattern } from "../proxy-runtime-types";
import { curryMaybeReference } from "../utils";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";

export type MaterializedRecordProxyInitTarget =
  | {
      map: Y.Map<AllowedYValue>;
      boundMaybeReference: ReturnType<typeof curryMaybeReference>;
    }
  | {
      map?: undefined;
      boundMaybeReference?: undefined;
    };

export const recordProxyInitMap = new Map<Record<string, AllowedYJSValue>, MaterializedRecordProxyInitTarget>();

export const buildRecordProxy = (
  init: MaterializedRecordProxyInitTarget,
  target: Record<string, AllowedYJSValue> = {}
) => {
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    for (const key of event.keysChanged){
      trackModification(self, key);
      target[key] = deref(init.map!.doc!, init.map!.get(key)!)
    }
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
  }
  init.map?.observe(observer)

  // We still need to track proxy target state even when we're materialized as it's important for property descriptors.
  // We cannot do dynamic proxy for them so we have to control it directly. Some decisions will look weird without that fact.
  const self = new Proxy(target, {
    get(proxyTarget, elementKey) {
      switch (elementKey) {
        case "clear":
          return () => {
            trackModification(self, ACCESS_ALL_SYMBOL);
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
            for (const key of Object.keys(proxyTarget)) {
              delete proxyTarget[key];
            }
            init.map?.clear();
          };
        case "assign":
          return (newEntries: Record<string, ModelPattern> | Iterable<[string, ModelPattern]>) => {
            trackModification(self, ACCESS_ALL_SYMBOL);
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
            for (const key of Object.keys(proxyTarget)) {
              delete proxyTarget[key];
            }
            Object.assign(proxyTarget, newEntries);
            if (init.map) {
              init.map.doc!.transact(() => {
                // Add new entries
                if (Symbol.iterator in Object(newEntries)) {
                  // Iterable of [key, value] pairs
                  for (const [k, v] of newEntries as Iterable<[string, ModelPattern]>) {
                    init.map.set(k, init.boundMaybeReference(v));
                  }
                } else {
                  // Record object
                  for (const [k, v] of Object.entries(newEntries as Record<string, ModelPattern>)) {
                    init.map.set(k, init.boundMaybeReference(v));
                  }
                }
              });
            }
          };
        case materializationSymbol:
          return (struct: Y.Map<AllowedYValue>, boundMaybeReference: ReturnType<typeof curryMaybeReference>) => {
            init.map?.unobserve(observer);
            init.map = struct;
            init.boundMaybeReference = boundMaybeReference;
            init.map.observe(observer);
          };
      }

      // Well-known Symbol support for record/map
      if (typeof elementKey === "symbol") {
        switch (elementKey) {
          case Symbol.toStringTag:
            return "Object";
        }
      }

      if (elementKey in Object.prototype) {
        // Accessing Object prototype methods. Todo make more precise
        if (typeof Object.prototype[elementKey] === "function") {
          return function (this: any, ...args) {
            if (this === self) {
              trackAccess(self, ACCESS_ALL_SYMBOL);
            }
            return Object.prototype[elementKey].apply(self, args);
          };
        } else {
          trackAccess(self, ACCESS_ALL_SYMBOL);
          return Object.prototype[elementKey];
        }
      } else if (typeof elementKey === "string") {
        // Specific field access
        trackAccess(self, elementKey);
        if (init.map) {
          return deref(init.map.doc!, init.map.get(elementKey) ?? null);
        } else {
          return proxyTarget[elementKey];
        }
      }
    },
    set(proxyTarget, elementKey, value) {
      if (typeof elementKey === "string") {
        trackModification(self, elementKey);
        proxyTarget[elementKey] = value;
        if (init.map) {
          if (value != null) {
            init.map.doc!.transact(() => {
              init.map.set(elementKey, init.boundMaybeReference(value));
            });
          } else {
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
            init.map.doc!.transact(() => {
              init.map.delete(elementKey);
            });
          }
        }
        return true;
      }
      console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
      return false;
    },
    deleteProperty(proxyTarget, elementKey) {
      // noinspection SuspiciousTypeOfGuard
      if (typeof elementKey === "symbol") {
        return false;
      }
      if (!init.map) {
        if (Reflect.deleteProperty(proxyTarget, elementKey)) {
          trackModification(self, ACCESS_INDICES_SET_SYMBOL);
          return true;
        }
        return false;
      }

      if (init.map.has(elementKey)) {
        trackModification(self, ACCESS_INDICES_SET_SYMBOL);
        init.map.doc!.transact(() => {
          init.map.delete(elementKey);
        });
        return true;
      }
      console.warn(`cannot delete property ${elementKey} as it's non-declared`);
      return false;
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(proxyTarget, elementKey) {
      if (typeof elementKey === "symbol") {
        return false;
      }
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return init.map?.has(elementKey) ?? Reflect.has(proxyTarget, elementKey);
    },
    ownKeys(proxyTarget) {
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return [...(init.map?.keys() ?? Reflect.ownKeys(proxyTarget))];
    }
  });
  recordProxyInitMap.set(self, init);
  return self;
};
