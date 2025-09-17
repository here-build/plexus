import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYJSValueMap,
  AllowedYValue,
  informOrphanizationSymbol,
  materializationSymbol,
  ReadonlyField,
  requestAdoptionSymbol,
  requestOrphanizationSymbol
} from "../proxy-runtime-types";
import { maybeReference, maybeTransacting } from "../utils";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { PlexusModel } from "../PlexusModel";
import { deref } from "../deref";

export type MaterializedRecordProxyInitTarget<T extends AllowedYJSValue> = {
  owner: PlexusModel;
  context: ClassAccessorDecoratorContext<PlexusModel, Record<string, T>> & { name: string };
  isChildField?: boolean;
};

export const buildRecordProxy = <T extends AllowedYJSValue>({ owner, context, isChildField }: MaterializedRecordProxyInitTarget<T>) => {
  const getYjsMap = () => owner._yjsModel?.get(context.name) as Y.Map<AllowedYValue> | null;
  let backingStorage: Record<string, T> = {};
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const map = getYjsMap();
    if (event.target !== map) {
      return;
    }
    for (const key of event.keysChanged) {
      backingStorage[key] = owner._deref(map.get(key)!) as T;
      trackModification(self, key);
    }
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
  };
  const map = getYjsMap();

  map?.observe(observer);
  if (map) {
    const {
      [YJS_GLOBALS.modelMetadataType]: _type,
      [YJS_GLOBALS.modelMetadataParent]: _parent,
      ...model
    } = map.toJSON();
    Object.assign(backingStorage, model);
  }

  // We still need to track proxy target state even when we're materialized as it's important for property descriptors.
  // We cannot do dynamic proxy for them so we have to control it directly. Some decisions will look weird without that fact.
  const self = new Proxy(backingStorage, {
    get(proxyTarget, elementKey) {
      switch (elementKey) {
        case "clear":
          return () => {
            if (Object.keys(proxyTarget).length === 0) {
              return;
            }
            // Clear parent tracking for all child values
            if (isChildField) {
              for (const value of Object.values(proxyTarget)) {
                value?.[informOrphanizationSymbol]?.();
              }
            }

            for (const key of Object.keys(proxyTarget)) {
              delete proxyTarget[key];
            }
            getYjsMap()?.clear();
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign":
          return (newEntries: Record<string, PlexusModel> | Iterable<[string, PlexusModel]>) => {
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for all old values
              if (isChildField) {
                for (const value of Object.values(proxyTarget)) {
                  value?.[informOrphanizationSymbol]?.();
                }
              }

              for (const key of Object.keys(proxyTarget)) {
                delete proxyTarget[key];
              }
              Object.assign(proxyTarget, newEntries);

              const map = getYjsMap();
              if (map) {
                maybeTransacting(owner._doc, () => {
                  map.clear();

                  // Add new entries and update parent tracking
                  if (Symbol.iterator in Object(newEntries)) {
                    // Iterable of [key, value] pairs
                    for (const [k, v] of newEntries as Iterable<[string, PlexusModel]>) {
                      if (isChildField && v) {
                        v[requestAdoptionSymbol]?.(owner, context.name, k);
                      }
                      map.set(k, maybeReference(v, owner._doc!));
                    }
                  } else {
                    // Record object
                    for (const [k, v] of Object.entries(newEntries as Record<string, PlexusModel>)) {
                      if (isChildField && v) {
                        v[requestAdoptionSymbol]?.(owner, context.name, k);
                      }
                      map.set(k, maybeReference(v, owner._doc!));
                    }
                  }
                });
              }
            });
          };
        case materializationSymbol:
          return () => {
            const map = getYjsMap()!;
            Object.assign(backingStorage, Object.fromEntries(
              Object.entries(map.toJSON()).map(([key, value]) => [key, deref(map.doc!, value)])
            ));
            map.observe(observer);
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
              trackAccess(owner, context.name);
              trackAccess(self, ACCESS_ALL_SYMBOL);
            }
            return Object.prototype[elementKey].apply(self, args);
          };
        } else {
          trackAccess(owner, context.name);
          trackAccess(self, ACCESS_ALL_SYMBOL);
          return Object.prototype[elementKey];
        }
      } else if (typeof elementKey === "string") {
        // Specific field access
        trackAccess(owner, context.name);
        trackAccess(self, elementKey);
        const map = getYjsMap();
        if (map) {
          if (!map.has(elementKey)) {
            return undefined;
          }
          return owner._deref(map.get(elementKey)!);
        } else {
          return proxyTarget[elementKey];
        }
      }
    },
    set(proxyTarget, elementKey, value) {
      if (typeof elementKey === "string") {
        maybeTransacting(owner._doc, () => {
          trackModification(self, elementKey);
          // Handle parent tracking for child fields
          if (isChildField) {
            // Clear parent tracking for old value if it exists
            const oldValue = proxyTarget[elementKey];
            oldValue?.[requestOrphanizationSymbol]?.();
          }
          proxyTarget[elementKey] = value;
          if (isChildField) {
            // Update parent tracking for new value
            if (value != null) {
              value[requestAdoptionSymbol]?.(owner, context.name, elementKey);
            }
          }
          const map = getYjsMap();

          if (map) {
            if (value != null) {
              map.set(elementKey, maybeReference(value, owner._doc!));
            } else {
              trackModification(self, ACCESS_INDICES_SET_SYMBOL);
              map.delete(elementKey);
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

      maybeTransacting(owner._doc, () => {
        // Handle parent tracking for child fields
        if (isChildField) {
          const oldValue = proxyTarget[elementKey];
          oldValue?.[informOrphanizationSymbol]?.();
        }
        const map = getYjsMap();

        if (!map) {
          if (Reflect.deleteProperty(proxyTarget, elementKey)) {
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
          }
          return true;
        }

        if (map.has(elementKey)) {
          map.delete(elementKey);
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
      trackAccess(owner, context.name);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return getYjsMap()?.has(elementKey) ?? Reflect.has(proxyTarget, elementKey);
    },
    ownKeys(proxyTarget) {
      trackAccess(owner, context.name);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return [...(getYjsMap()?.keys() ?? Reflect.ownKeys(proxyTarget))];
    }
  });
  return self as Record<string, T> & ReadonlyField<Record<string, T>>;
};
