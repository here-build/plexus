import type * as Y from "yjs";

import { deref } from "../deref.js";
import type { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informOrphanizationSymbol,
  materializationSymbol,
  requestAdoptionSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import { ACCESS_ALL_SYMBOL, ENTRIES_LENGTH_SYMBOL, KEYS_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeArrayForField } from "../virtual-children-genesis.js";

export type MaterializedSetProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildSetProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
}: MaterializedSetProxyInitTarget) => {
  let backingSet = new Set<T>();
  let needsRegeneration = false;
  const getBackgingSet = () => {
    if (needsRegeneration) {
      needsRegeneration = false;
      backingSet = new Set(
        getYjsSet()!
          .toArray()
          .map((item) => deref(owner.__doc__!, item) as T),
      );
    }
    return backingSet;
  };
  const getYjsSet = (): Y.Array<AllowedYValue> | null => {
    return (owner.__yjsFieldsMap__?.get(key) as Y.Array<AllowedYValue>) ?? null;
  };

  const attachObserver = (arr: Y.Array<AllowedYValue>) => {
    if (undoManagerNotifications.has(arr)) return;
    arr.observe(observer);
    undoManagerNotifications.set(arr, observer);
  };

  const ensureYjsSet = (): Y.Array<AllowedYValue> | null => {
    const existing = getYjsSet();
    if (existing) return existing;
    if (!owner.__doc__ || !owner.__yjsFieldsMap__) return null;
    const arr = materializeArrayForField(owner, key);
    attachObserver(arr);
    return arr;
  };
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    if (event.target !== getYjsSet()) {
      return;
    }
    needsRegeneration = true;
    // YJS changes are always key changes (add/delete)
    trackModification(self, KEYS_SYMBOL);
    trackModification(self, ENTRIES_LENGTH_SYMBOL);
  };
  const yjsSet = getYjsSet();
  if (yjsSet) {
    attachObserver(yjsSet);
  }

  const self = new Proxy(Object.seal(backingSet), {
    get(_, elementKey) {
      switch (elementKey) {
        case "size":
          trackAccess(owner, key);
          trackAccess(self, ENTRIES_LENGTH_SYMBOL);
          return getYjsSet()?.length ?? getBackgingSet().size;
        case "add":
          return (value: T) => {
            const backingStorage = getBackgingSet();
            // Already in set - no-op
            if (backingStorage.has(value)) {
              return false;
            }

            // For child fields, call requestAdoptionSymbol BEFORE modifying state
            // This includes cycle detection and will throw if the add would create a cycle
            if (isChildField) {
              value?.[requestAdoptionSymbol]?.(owner, key);
            }

            // Now safe to add to backing set
            backingStorage.add(value);
            ensureYjsSet(); // create container outside tracked transaction
            maybeTransacting(owner.__doc__!, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
              // Y.Array.push expects an array of items
              getYjsSet()?.push([maybeReference(value, owner.__doc__!)]);
            });
            return true;
          };
        case "clear":
          return () => {
            const currentBackingSet = getBackgingSet();
            const outputLength = currentBackingSet.size;
            if (outputLength === 0) {
              return;
            }
            maybeTransacting(owner.__doc__!, () => {
              // Orphan all items BEFORE clearing the backing set
              if (isChildField) {
                for (const item of currentBackingSet) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }

              currentBackingSet.clear();
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);

              getYjsSet()?.delete(0, outputLength);
            });
            return;
          };
        case "assign":
          return (newValues: Iterable<T>) => {
            const newValuesSet = new Set(newValues);
            if (newValuesSet.size > 0) ensureYjsSet();
            const yjsArray = getYjsSet();
            maybeTransacting(owner.__doc__, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);

              if (isChildField) {
                // VALIDATE FIRST: Check all truly new values can be adopted before any state changes
                for (const value of newValuesSet) {
                  if (value && !backingSet.has(value)) {
                    value[validateAdoptionSymbol]?.(owner, key);
                  }
                }

                // Now safe to orphan values that aren't in the new set
                for (const item of backingSet) {
                  if (item && !newValuesSet.has(item)) {
                    item[informOrphanizationSymbol]?.();
                  }
                }
              }

              // Clear existing contents
              yjsArray?.delete(0, yjsArray.length);

              // Adopt truly new values
              if (isChildField) {
                for (const value of newValuesSet) {
                  if (value && !backingSet.has(value)) {
                    value[requestAdoptionSymbol]?.(owner, key);
                  }
                }
              }
              yjsArray?.push([...newValuesSet].map((value) => maybeReference(value, owner.__doc__!)));
              backingSet = newValuesSet;
            });
          };
        case "delete":
          return (value: T) => {
            const backingSet = getBackgingSet();
            if (!backingSet.delete(value)) {
              return false;
            }
            const yjsArray = getYjsSet();
            if (isChildField) {
              value?.[informOrphanizationSymbol]?.();
            }

            if (yjsArray) {
              maybeTransacting(owner.__doc__, () => {
                // Clear parent tracking for removed item
                const index = yjsArray
                  .toArray()
                  .map((item) => deref(owner.__doc__!, item))
                  .indexOf(value);

                yjsArray.delete(index, 1);
              });
            }
            trackModification(self, KEYS_SYMBOL);
            trackModification(self, ENTRIES_LENGTH_SYMBOL);
            return true;
          };
        case "entries":
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().entries();
          };
        case "values":
        case "keys":
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().values();
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet()[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Set";
        case "forEach":
          return (callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            // eslint-disable-next-line unicorn/no-array-method-this-argument,unicorn/no-array-for-each
            return getBackgingSet().forEach(callbackfn, thisArg);
          };
        case "has":
          return (value: T) => {
            trackAccess(owner, key);
            trackAccess(self, KEYS_SYMBOL);
            return getBackgingSet().has(value);
          };
        case "intersection":
          throw new Error("not implemented yet");
        case "isDisjointFrom":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isDisjointFrom(set);
          };
        case "isSubsetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isSubsetOf(set);
          };
        case "isSupersetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isSupersetOf(set);
          };
        case materializationSymbol:
          return () => {
            const yjsSet = getYjsSet();
            if (!yjsSet) {
              // Container absent or removed (e.g., by undo) — clear the proxy
              backingSet = new Set();
              needsRegeneration = false;
              return;
            }
            needsRegeneration = true;
            attachObserver(yjsSet);
          };
        default:
          return false;
      }
    },
  });
  return self as Set<T> & ReadonlyField<Set<T>>;
};
