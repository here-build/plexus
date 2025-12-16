import type * as Y from "yjs";

import { deref } from "../deref.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informOrphanizationSymbol,
  materializationSymbol,
  requestAdoptionSymbol,
  requestOrphanizationSymbol,
} from "../proxy-runtime-types.js";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import invariant from "tiny-invariant";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";

export type MaterializedRecordProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildRecordProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
}: MaterializedRecordProxyInitTarget) => {
  const getYjsMap = () => owner.__yjsFieldsMap__?.get(key) as Y.Map<AllowedYValue> | null;
  const backingStorage: Record<string, T> = {};
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const yjsMap = getYjsMap();
    if (event.target !== yjsMap) {
      return;
    }
    for (const key of event.keysChanged) {
      if (yjsMap.has(key)) {
        invariant(
          yjsMap.doc,
          `Plexus<${owner.__type__}#${owner.uuid}.${key}>: observer triggered for Y.Map without doc`,
        );
        backingStorage[key] = deref(yjsMap.doc!, yjsMap.get(key)!) as T;
      } else {
        delete backingStorage[key];
      }
      trackModification(self, key);
    }
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
  };
  {
    const map = getYjsMap();

    // Register for undo notifications
    if (map) {
      map.observe(observer);
      undoManagerNotifications.set(map, observer);
      Object.assign(backingStorage, map.toJSON());
    }
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
          return (newEntries: Record<string, AllowedYJSValue> | Iterable<[string, AllowedYJSValue]>) => {
            maybeTransacting(owner.__doc__, () => {
              // Clear parent tracking for all old values
              if (isChildField) {
                for (const value of Object.values(proxyTarget)) {
                  // todo this may be actually redundantly emitting orphanisations - we need real diffs
                  value?.[informOrphanizationSymbol]?.();
                }
              }

              for (const key of Object.keys(proxyTarget)) {
                delete proxyTarget[key];
              }
              Object.assign(proxyTarget, newEntries);

              const map = getYjsMap();
              map?.clear();

              trackModification(self, ACCESS_ALL_SYMBOL);
              if (isChildField || map) {
                for (const [k, v] of Symbol.iterator in newEntries ? newEntries : Object.entries(newEntries)) {
                  if (isChildField) {
                    v?.[requestAdoptionSymbol]?.(owner, key, k);
                  }
                  map?.set(k, maybeReference(v, owner.__doc__!));
                }
              }
            });
          };
        case materializationSymbol:
          return () => {
            const map = getYjsMap()!;
            Object.assign(
              backingStorage,
              Object.fromEntries(Object.entries(map.toJSON()).map(([key, value]) => [key, deref(map.doc!, value)])),
            );
            map.observe(observer);
            // Register for undo notifications during materialization
            undoManagerNotifications.set(map, observer);
          };
      }

      // Well-known Symbol support for record/map - intentionally preserved as switch to represent flat routing
      if (typeof elementKey === "symbol") {
        // eslint-disable-next-line sonarjs/no-small-switch
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
              trackAccess(owner, key);
              trackAccess(self, ACCESS_ALL_SYMBOL);
            }
            return Object.prototype[elementKey].apply(self, args);
          };
        } else {
          trackAccess(owner, key);
          trackAccess(self, ACCESS_ALL_SYMBOL);
          return Object.prototype[elementKey];
        }
      } else if (typeof elementKey === "string") {
        // Specific field access
        trackAccess(owner, key);
        trackAccess(self, elementKey);
        // we intentionally treat undefined as null for smaller yjs doc size and consistency
        // (as we do not differentiate missing field and empty field anywhere but in `has`)
        return proxyTarget[elementKey];
      }
    },
    set(proxyTarget, elementKey, value) {
      if (typeof elementKey === "string") {
        maybeTransacting(owner.__doc__, () => {
          trackModification(self, elementKey);
          if ((elementKey in proxyTarget && value == null) || (!(elementKey in proxyTarget) && value != null)) {
            trackModification(self, ACCESS_INDICES_SET_SYMBOL);
          }
          if (isChildField) {
            // Handle parent tracking for child fields. Clear parent tracking for old value if it exists
            proxyTarget[elementKey]?.[requestOrphanizationSymbol]?.();
          }
          if (value == null) {
            delete proxyTarget[elementKey];
          } else {
            proxyTarget[elementKey] = value;
          }
          if (isChildField) {
            // Update parent tracking for new value
            value?.[requestAdoptionSymbol]?.(owner, key, elementKey);
          }
          if (value == null) {
            getYjsMap()?.delete(elementKey);
          } else {
            getYjsMap()?.set(elementKey, maybeReference(value, owner.__doc__!));
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
        return true;
      }
      if (!Object.hasOwn(proxyTarget, elementKey)) {
        return true;
      }

      return maybeTransacting(owner.__doc__, () => {
        // Handle parent tracking for child fields
        if (isChildField) {
          proxyTarget[elementKey]?.[informOrphanizationSymbol]?.();
        }
        getYjsMap()?.delete(elementKey);
        if (Reflect.deleteProperty(proxyTarget, elementKey)) {
          trackModification(self, elementKey);
          trackModification(self, ACCESS_INDICES_SET_SYMBOL);
        }
        return true;
      });
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(proxyTarget, elementKey) {
      if (typeof elementKey === "symbol") {
        return false;
      }
      trackAccess(owner, key);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return Reflect.has(proxyTarget, elementKey);
    },
    ownKeys(proxyTarget) {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return Reflect.ownKeys(proxyTarget);
    },
  });
  return self as Record<string, T> & ReadonlyField<Record<string, T>>;
};
