import * as Y from "yjs";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import {
  AllowedYJSValue,
  AllowedYValue,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  ReadonlyField,
  requestAdoptionSymbol,
  requestOrphanizationSymbol
} from "../proxy-runtime-types";
import { maybeReference, maybeTransacting } from "../utils";
import { mutableArrayMethods } from "../globals";
import { PlexusModel } from "../PlexusModel";

// Node/JS engines prior to Set.prototype.difference support
function setDifference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const diff = (a as any).difference;
  if (typeof diff === "function") {
    return diff.call(a, b);
  }
  const res = new Set<T>();
  for (const v of a) if (!b.has(v)) res.add(v);
  return res;
}

export type MaterializedArrayProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildArrayProxy = <T extends AllowedYJSValue>({ owner, key, isChildField }: MaterializedArrayProxyInitTarget) => {
  let backingArray: Array<T | null> = [];
  const getYjsArray = () => owner._yjsModel?.get(key) as Y.Array<AllowedYValue> | null;
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    const yjsArray = getYjsArray();
    if (event.target !== yjsArray) {
      return;
    }
    // todo narrowed observer event triggers
    // Update target array to maintain target-proxy parity for property descriptors
    if (yjsArray) {
      // we specifically need splice to keep pointer and thus make proxy working
      backingArray.splice(0, backingArray.length, ...yjsArray.toArray().map((item) => owner._deref(item) as T));
    }
    trackModification(self, ACCESS_ALL_SYMBOL);
  };
  getYjsArray()?.observe(observer);

  const self = new Proxy(backingArray, {
    // eslint-disable-next-line sonarjs/cognitive-complexity
    get(_, elementKey) {
      // MUTATING ARRAY METHODS: Convert entities to references, sync to YJS
      switch (elementKey) {
        case "push":
          // arr.push(entity) → yArray.push(entity.reference())
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<T>) =>
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Update parent tracking for child fields
              let reusedElements = new Set<T>();
              if (isChildField) {
                for (const element of elements) {
                  if (backingArray.includes(element)) {
                    reusedElements.add(element);
                  }
                  element?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray.push(...elements);
              for (const element of reusedElements) {
                element?.[informAdoptionSymbol](owner, key);
              }
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.push(elements.map((element) => maybeReference(element, owner._doc!)));
                return yjsArray.length;
              } else {
                return backingArray.length;
              }
            });
        case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<T>) => {
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Update parent tracking for child fields
              if (isChildField) {
                for (const element of elements) {
                  element?.[requestAdoptionSymbol]?.(owner, key);
                }
              }

              backingArray.unshift(...elements);
              const yjsArray = getYjsArray();
              if (yjsArray) {
                yjsArray.unshift(elements.map((element) => maybeReference(element, owner._doc!)));
                return yjsArray.length;
              } else {
                return backingArray.length;
              }
            });
          };
        case "clear": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return () => {
            const yjsArray = getYjsArray();
            // Clear parent tracking for all items
            if (yjsArray && isChildField) {
              for (const item of backingArray) {
                item?.[informOrphanizationSymbol]?.();
              }
            }

            backingArray.splice(0, backingArray.length);
            if (yjsArray) {
              // Clear existing contents
              yjsArray.delete(0, yjsArray.length);
            }
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (newElements: Array<T>) => {
            if (newElements.length === backingArray.length && newElements.every((val, i) => val === backingArray[i])) {
              return;
            }
            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              if (isChildField) {
                // todo duplicate models detection
                // Clear parent tracking for old items
                const removedItems = setDifference(new Set(backingArray), new Set(newElements));
                const addedItems = setDifference(new Set(newElements), new Set(backingArray));
                for (const item of removedItems) {
                  item?.[informOrphanizationSymbol]?.();
                }
                for (const item of addedItems) {
                  item?.[requestAdoptionSymbol]?.(owner, key);
                }
              }
              const yjsArray = getYjsArray();

              backingArray.splice(0, backingArray.length, ...newElements);
              if (yjsArray) {
                // Clear existing contents
                yjsArray.delete(0, yjsArray.length);
                // Add new elements
                yjsArray.push(newElements.map((element) => maybeReference(element, owner._doc!)));
              }
            });
          };
        case "length": // Report length access to this array
          trackAccess(owner, key);
          trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
          return backingArray.length;
        case materializationSymbol:
          return () => {
            const yjsArray = getYjsArray()!;
            backingArray.splice(0, backingArray.length, ...yjsArray.toArray().map((item) => owner._deref(item) as T));
            yjsArray.observe(observer);
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingArray[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Array";
        case Symbol.isConcatSpreadable:
          return true;
      }

      // eslint-disable-next-line sonarjs/no-in-misuse
      if (elementKey in Array.prototype) {
        if (typeof Array.prototype[elementKey] === "function") {
          return mutableArrayMethods.has(elementKey)
            ? // eslint-disable-next-line sonarjs/no-nested-functions
              (...args) => {
                const yjsArray = getYjsArray();
                if (!yjsArray) {
                  const result = backingArray[elementKey](...args);
                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return result;
                }
                return maybeTransacting(yjsArray?.doc, () => {
                  const array = backingArray;
                  const resultingArray = [...array];
                  const result = resultingArray[elementKey](...args);
                  if (resultingArray.length === array.length && resultingArray.every((val, i) => val === array[i])) {
                    return result;
                  }

                  // todo duplicate models detection
                  // Clear parent tracking for old items
                  const removedItems = setDifference(new Set(backingArray), new Set(resultingArray));
                  const addedItems = setDifference(new Set(resultingArray), new Set(backingArray));
                  for (const item of removedItems) {
                    item?.[informOrphanizationSymbol]?.();
                  }
                  for (const item of addedItems) {
                    item?.[requestAdoptionSymbol]?.(owner, key);
                  }

                  maybeTransacting(yjsArray.doc, () => {
                    // todo optimized update strategy
                    yjsArray.delete(0, yjsArray.length);
                    yjsArray.push(resultingArray.map((element) => maybeReference(element, owner._doc!)));
                  });
                  trackModification(self, ACCESS_ALL_SYMBOL);
                  backingArray.splice(0, backingArray.length, ...resultingArray);
                  return result;
                });
              }
            : // eslint-disable-next-line sonarjs/no-nested-functions
              (...args) => {
                // Non-mutating array methods that iterate over all elements
                trackAccess(owner, key);
                trackAccess(self, ACCESS_ALL_SYMBOL);
                return backingArray[elementKey](...args);
              };
        } else {
          // Report keyset access to this array for Array.prototype property access
          trackAccess(owner, key);
          trackAccess(self, elementKey);
          return Array.prototype[elementKey];
        }
      }
      // ARRAY ELEMENT ACCESS: arr[0] → deref(yArray.get(0))
      // Converts YJS References back to live entity objects
      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          // Report specific index access
          trackAccess(owner, key);
          trackAccess(self, elementKey);
          return backingArray[parsedElementKey];
        }
      }
    },
    // eslint-disable-next-line sonarjs/cognitive-complexity
    set(_, elementKey, value) {
      return maybeTransacting(owner._doc, () => {
        trackModification(self, elementKey);
        if (elementKey === "length") {
          // Handle array length truncation
          const newLength = Number(value);
          const yjsArray = getYjsArray();
          if (Number.isSafeInteger(newLength) && newLength >= 0) {
            if (newLength < backingArray.length) {
              // eslint-disable-next-line sonarjs/no-nested-functions
              // Clear parent tracking for truncated items
              if (isChildField) {
                for (const item of backingArray.slice(newLength)) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }
              backingArray.length = newLength;

              yjsArray?.delete(newLength, yjsArray.length - newLength);
            } else if (newLength > backingArray.length) {
              const gap = [] as null[];
              while (backingArray.length + gap.length <= newLength) {
                gap.push(null);
              }
              backingArray.push(...gap);
              yjsArray?.push(gap);
            }
            return true;
          }
          return false;
        }
        if (typeof elementKey === "string") {
          const parsedElementKey = Number.parseInt(elementKey);
          if (Number.isSafeInteger(parsedElementKey)) {
            if (parsedElementKey < 0) {
              console.warn(`cannot set [${parsedElementKey}] as it's below zero`);
              return false;
            } else {
              if (backingArray[parsedElementKey] === value) {
                return true;
              }
              // Fill holes with null to match YJS behavior
              while (backingArray.length < parsedElementKey) {
                backingArray.push(null as any);
              }
              backingArray[parsedElementKey] = value;

              // Handle parent tracking for replaced item
              if (isChildField) {
                // Clear parent for old item at this index
                if (parsedElementKey < backingArray.length) {
                  backingArray[parsedElementKey]?.[informOrphanizationSymbol]?.();
                }

                value?.[requestOrphanizationSymbol]?.();
              }

              const yjsArray = getYjsArray();
              if (!yjsArray) {
                return true;
              }

              if (parsedElementKey >= yjsArray.length) {
                // eslint-disable-next-line sonarjs/no-nested-functions
                const postfix: null[] = [];
                while (postfix.length + yjsArray.length < parsedElementKey - 1) {
                  postfix.push(null);
                }
                yjsArray.push([...postfix, maybeReference(value, owner._doc!)]);
              } else {
                // eslint-disable-next-line sonarjs/no-nested-functions
                yjsArray.delete(parsedElementKey, 1);
                yjsArray.insert(parsedElementKey, [maybeReference(value, owner._doc!)]);
              }
              value?.[informAdoptionSymbol]?.(owner, key);
            }
            return true;
          }
        }
        console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
        return false;
      });
    },
    deleteProperty() {
      return false;
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(_, elementKey) {
      if (elementKey === "length") {
        return true;
      }
      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          return parsedElementKey >= 0 && parsedElementKey < backingArray.length;
        }
      }
      // eslint-disable-next-line sonarjs/no-in-misuse
      return elementKey in Array.prototype;
    },
    ownKeys(target) {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_ALL_SYMBOL);
      return Reflect.ownKeys(target);
    }
  });
  return self as T[] & ReadonlyField<T[]>;
};
