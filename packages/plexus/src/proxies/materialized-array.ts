import * as Y from "yjs";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import {
  AllowedYJSValue,
  AllowedYValue,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  ModelPattern,
  requestAdoptionSymbol,
  requestOrphanizationSymbol
} from "../proxy-runtime-types";
import { curryMaybeReference, maybeTransacting } from "../utils";
import { deref } from "../deref";
import { mutableArrayMethods } from "../globals";

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

export type MaterializedArrayProxyInitTarget =
  | {
      owner: ModelPattern;
      list: Y.Array<AllowedYValue>;
      boundMaybeReference: ReturnType<typeof curryMaybeReference>;
      ownerEntityId: string;
      fieldName: string;
      isChildField: boolean;
    }
  | {
      owner: ModelPattern;
      list?: undefined;
      boundMaybeReference?: undefined;
      ownerEntityId: string;
      fieldName: string;
      isChildField: boolean;
    };

export const buildArrayProxy = (init: MaterializedArrayProxyInitTarget, target: AllowedYJSValue[] = []) => {
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    if (event.target !== init.list) {
      return;
    }
    // todo narrowed observer event triggers
    // Update target array to maintain target-proxy parity for property descriptors
    if (init.list) {
      const newArray = init.list.toArray().map((item) => deref(init.list.doc!, item));
      target.splice(0, target.length, ...newArray);
    }
    trackModification(self, ACCESS_ALL_SYMBOL);
  };
  init.list?.observe(observer);

  const self = new Proxy(target, {
    // eslint-disable-next-line sonarjs/cognitive-complexity
    get(_, elementKey) {
      // MUTATING ARRAY METHODS: Convert entities to references, sync to YJS
      switch (elementKey) {
        case "push":
          // arr.push(entity) → yArray.push(entity.reference())
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<ModelPattern | null>) =>
            maybeTransacting(init.list?.doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Update parent tracking for child fields
              if (init.isChildField) {
                for (const element of elements) {
                  element?.[requestAdoptionSymbol]?.(init.owner, init.fieldName);
                }
              }

              target.push(...elements);
              if (init.list) {
                init.list.push(elements.map(init.boundMaybeReference));
                return init.list.length;
              } else {
                return target.length;
              }
            });
        case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<ModelPattern | null>) => {
            maybeTransacting(init.list?.doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Update parent tracking for child fields
              if (init.isChildField) {
                for (const element of elements) {
                  element?.[requestAdoptionSymbol]?.(init.owner, init.fieldName);
                }
              }

              target.unshift(...elements);
              if (init.list) {
                init.list.unshift(elements.map(init.boundMaybeReference));
                return init.list.length;
              } else {
                return target.length;
              }
            });
          };
        case "clear": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return () => {
            // Clear parent tracking for all items
            if (init.list && init.isChildField) {
              for (const item of target) {
                item?.[informOrphanizationSymbol]?.();
              }
            }

            target.splice(0, target.length);
            if (init.list) {
              // Clear existing contents
              init.list.delete(0, init.list.length);
            }
            trackModification(self, ACCESS_ALL_SYMBOL);
          };
        case "assign": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (newElements: Array<ModelPattern | null>) => {
            if (newElements.length === target.length && newElements.every((val, i) => val === target[i])) {
              return;
            }
            maybeTransacting(init.list?.doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              if (init.isChildField) {
                // todo duplicate models detection
                // Clear parent tracking for old items
                const removedItems = setDifference(new Set(target), new Set(newElements));
                const addedItems = setDifference(new Set(newElements), new Set(target));
                for (const item of removedItems) {
                  item?.[informOrphanizationSymbol]?.();
                }
                for (const item of addedItems) {
                  item?.[requestAdoptionSymbol]?.(init.owner, init.fieldName);
                }
              }

              target.splice(0, target.length, ...newElements);
              if (init.list) {
                // Clear existing contents
                init.list.delete(0, init.list.length);
                // Add new elements
                init.list.push(newElements.map(init.boundMaybeReference));
              }
            });
          };
        case "length": // Report length access to this array
          trackAccess(init.owner, init.fieldName);
          trackAccess(self, ACCESS_INDICES_SET_SYMBOL);

          return init.list?.length ?? target.length;
        case materializationSymbol:
          return (struct: Y.Array<AllowedYValue>, boundMaybeReference: ReturnType<typeof curryMaybeReference>) => {
            if (init.list) {
              console.warn("trying to re-materialize array", init, struct);
            }
            init.list?.unobserve(observer);
            init.list = struct;
            init.boundMaybeReference = boundMaybeReference;
            init.list.observe(observer);
          };
        case Symbol.iterator:
          return () => {
            trackAccess(init.owner, init.fieldName);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target[Symbol.iterator]();
            }
            return init.list
              .toArray()
              .map((item) => deref(init.list.doc!, item))
              [Symbol.iterator]();
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
                if (!init.list) {
                  const result = target[elementKey](...args);
                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return result;
                }
                return maybeTransacting(init.list?.doc, () => {
                  const array = init.list.toArray().map((item) => deref(init.list.doc!, item));
                  const resultingArray = [...array];
                  const result = resultingArray[elementKey](...args);
                  if (resultingArray.length === array.length && resultingArray.every((val, i) => val === array[i])) {
                    return result;
                  }

                  // todo duplicate models detection
                  // Clear parent tracking for old items
                  const removedItems = setDifference(new Set(target), new Set(resultingArray));
                  const addedItems = setDifference(new Set(resultingArray), new Set(target));
                  for (const item of removedItems) {
                    item?.[informOrphanizationSymbol]?.();
                  }
                  for (const item of addedItems) {
                    item?.[requestAdoptionSymbol]?.(init.owner, init.fieldName);
                  }

                  maybeTransacting(init.list.doc, () => {
                    // todo optimized update strategy
                    init.list.delete(0, init.list.length);
                    init.list.push(resultingArray.map(init.boundMaybeReference));
                  });
                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return result;
                });
              }
            : // eslint-disable-next-line sonarjs/no-nested-functions
              (...args) => {
                if (!init.list) {
                  return target[elementKey](...args);
                }
                // Non-mutating array methods that iterate over all elements
                trackAccess(init.owner, init.fieldName);
                trackAccess(self, ACCESS_ALL_SYMBOL);
                return init.list
                  .toArray()
                  .map((item) => deref(init.list.doc!, item))
                  [elementKey](...args);
              };
        } else {
          // Report keyset access to this array for Array.prototype property access
          trackAccess(init.owner, init.fieldName);
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
          trackAccess(init.owner, init.fieldName);
          trackAccess(self, elementKey);
          if (!init.list) {
            return target[parsedElementKey];
          }
          return deref(init.list.doc!, init.list.get(parsedElementKey)); // Reference → live entity
        }
      }
    },
    // eslint-disable-next-line sonarjs/cognitive-complexity
    set(_, elementKey, value) {
      return maybeTransacting(init.list?.doc, () => {
        trackModification(self, elementKey);
        if (elementKey === "length") {
          // Handle array length truncation
          const newLength = Number(value);
          if (Number.isSafeInteger(newLength) && newLength >= 0) {
            if (!init.list) {
              for (const item of target) {
                item?.[informOrphanizationSymbol]?.();
              }
              target.length = newLength;
              return true;
            }
            if (newLength < init.list.length) {
              // eslint-disable-next-line sonarjs/no-nested-functions
              // Clear parent tracking for truncated items
              if (init.isChildField) {
                for (const item of target) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }

              init.list.delete(newLength, init.list.length - newLength);
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
              if (!init.list) {
                target[parsedElementKey] = value;
                return true;
              }
              if (deref(init.list.doc!, init.list.get(parsedElementKey)) === value) {
                return true;
              }

              // Handle parent tracking for replaced item
              if (init.isChildField) {
                // Clear parent for old item at this index
                if (parsedElementKey < init.list.length) {
                  target[parsedElementKey]?.[informOrphanizationSymbol]?.();
                }

                value?.[requestOrphanizationSymbol]?.();
              }

              if (parsedElementKey > init.list.length) {
                // eslint-disable-next-line sonarjs/no-nested-functions
                const postfix: null[] = [];
                while (postfix.length + init.list.length < parsedElementKey - 1) {
                  postfix.push(null);
                }
                init.list.push([...postfix, init.boundMaybeReference(value)]);
              } else {
                // eslint-disable-next-line sonarjs/no-nested-functions
                init.list.delete(parsedElementKey, 1);
                init.list.insert(parsedElementKey, [init.boundMaybeReference(value)]);
              }
              value?.[informAdoptionSymbol]?.(init.owner, init.fieldName);
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
          return parsedElementKey >= 0 && parsedElementKey < (init.list?.length ?? target.length);
        }
      }
      // eslint-disable-next-line sonarjs/no-in-misuse
      return elementKey in Array.prototype;
    },
    ownKeys(target) {
      trackAccess(init.owner, init.fieldName);
      trackAccess(self, ACCESS_ALL_SYMBOL);
      return Reflect.ownKeys(init.list?.toArray() ?? target);
    }
  });
  return self;
};
