import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  informOrphanizationSymbol,
  materializationSymbol,
  ModelPattern,
  requestAdoptionSymbol,
  requestOrphanizationSymbol
} from "../proxy-runtime-types";
import { curryMaybeReference, maybeTransacting } from "../utils";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

export type MaterializedRecordProxyInitTarget =
  | {
      owner: ModelPattern;
      map: Y.Map<AllowedYValue>;
      boundMaybeReference: ReturnType<typeof curryMaybeReference>;
      ownerEntityId: string;
      fieldName: string;
      isChildField: boolean;
    }
  | {
      owner: ModelPattern;
      map?: undefined;
      boundMaybeReference?: undefined;
      ownerEntityId: string;
      fieldName: string;
      isChildField: boolean;
    };

export const buildRecordProxy = (
  init: MaterializedRecordProxyInitTarget,
  target: Record<string, AllowedYJSValue> = {}
) => {
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    for (const key of event.keysChanged) {
      target[key] = deref(init.map!.doc!, init.map!.get(key)!);
      trackModification(self, key);
    }
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
  };
  init.map?.observe(observer);
  if (init.map) {
    const {
      [YJS_GLOBALS.modelMetadataType]: _type,
      [YJS_GLOBALS.modelMetadataParent]: _parent,
      ...model
    } = init.map.toJSON();
    Object.assign(target, model);
  }

  // We still need to track proxy target state even when we're materialized as it's important for property descriptors.
  // We cannot do dynamic proxy for them so we have to control it directly. Some decisions will look weird without that fact.
  const self = new Proxy(target, {
    get(proxyTarget, elementKey) {
      switch (elementKey) {
        case "clear":
          return () => {
            // Clear parent tracking for all child values
            if (init.isChildField) {
              for (const value of Object.values(proxyTarget)) {
                value?.[informOrphanizationSymbol]?.();
              }
            }

            for (const key of Object.keys(proxyTarget)) {
              delete proxyTarget[key];
            }
            init.map?.clear();
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign":
          return (newEntries: Record<string, ModelPattern> | Iterable<[string, ModelPattern]>) => {
            maybeTransacting(init.map?.doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for all old values
              if (init.isChildField) {
                for (const value of Object.values(proxyTarget)) {
                  value?.[informOrphanizationSymbol]?.();
                }
              }

              for (const key of Object.keys(proxyTarget)) {
                delete proxyTarget[key];
              }
              Object.assign(proxyTarget, newEntries);

              if (init.map) {
                maybeTransacting(init.map.doc, () => {
                  init.map.clear();

                  // Add new entries and update parent tracking
                  if (Symbol.iterator in Object(newEntries)) {
                    // Iterable of [key, value] pairs
                    for (const [k, v] of newEntries as Iterable<[string, ModelPattern]>) {
                      if (init.isChildField && v) {
                        v[requestAdoptionSymbol]?.(init.owner, init.fieldName, k);
                      }
                      init.map.set(k, init.boundMaybeReference(v));
                    }
                  } else {
                    // Record object
                    for (const [k, v] of Object.entries(newEntries as Record<string, ModelPattern>)) {
                      if (init.isChildField && v) {
                        v[requestAdoptionSymbol]?.(init.owner, init.fieldName, k);
                      }
                      init.map.set(k, init.boundMaybeReference(v));
                    }
                  }
                });
              }
            });
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
          if (!init.map.has(elementKey)) {
            return undefined;
          }
          return deref(init.map.doc!, init.map.get(elementKey)!);
        } else {
          return proxyTarget[elementKey];
        }
      }
    },
    set(proxyTarget, elementKey, value) {
      if (typeof elementKey === "string") {
        maybeTransacting(init.map?.doc, () => {
          trackModification(self, elementKey);
          // Handle parent tracking for child fields
          if (init.isChildField) {
            // Clear parent tracking for old value if it exists
            const oldValue = proxyTarget[elementKey];
            oldValue?.[requestOrphanizationSymbol]?.();
          }
          proxyTarget[elementKey] = value;
          if (init.isChildField) {
            // Update parent tracking for new value
            if (value != null) {
              value[requestAdoptionSymbol]?.(init.owner, init.fieldName, elementKey);
            }
          }

          if (init.map) {
            if (value != null) {
              init.map.set(elementKey, init.boundMaybeReference(value));
            } else {
              trackModification(self, ACCESS_INDICES_SET_SYMBOL);
              init.map.delete(elementKey);
            }
          }
        });
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

      maybeTransacting(init.map?.doc, () => {
        // Handle parent tracking for child fields
        if (init.isChildField) {
          const oldValue = proxyTarget[elementKey];
          oldValue?.[informOrphanizationSymbol]?.();
        }

        if (!init.map) {
          if (Reflect.deleteProperty(proxyTarget, elementKey)) {
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
          }
          return true;
        }

        if (init.map.has(elementKey)) {
          init.map.delete(elementKey);
          trackModification(self, ACCESS_INDICES_SET_SYMBOL);
          return true;
        }
      });
      return true;
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
  return self;
};
