import * as Y from "yjs";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import {
  AllowedYJSValue,
  AllowedYValue,
  materializationSymbol,
  ModelPattern,
  reportOrphanSymbol,
  reportParentshipSymbol
} from "../proxy-runtime-types";
import { curryMaybeReference, maybeTransacting } from "../utils";
import { deref } from "../deref";
import { mutableArrayMethods } from "../globals";

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
export const listProxyInitMap = new Map<AllowedYJSValue[], MaterializedArrayProxyInitTarget>();

export const buildArrayProxy = (init: MaterializedArrayProxyInitTarget, target: AllowedYJSValue[] = []) => {
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    // todo narrowed observer event triggers
    // Update target array to maintain target-proxy parity for property descriptors
    if (init.list) {
      const newArray = init.list.toArray().map((item) => deref(init.list.doc!, item));
      target.splice(0, target.length, ...newArray);
    }
    trackModification(self, ACCESS_ALL_SYMBOL);
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
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
          return (...elements: Array<ModelPattern | null>) => {
            trackModification(self, ACCESS_ALL_SYMBOL);
            maybeTransacting(init.list?.doc, () => {
              // Update parent tracking for child fields
              if (init.isChildField) {
                for (const element of elements) {
                  element?.[reportParentshipSymbol]?.(init.owner, init.fieldName);
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
          };
        case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (...elements: Array<ModelPattern | null>) => {
            trackModification(self, ACCESS_ALL_SYMBOL);
            maybeTransacting(init.list?.doc, () => {
              // Update parent tracking for child fields
              if (init.isChildField) {
                for (const element of elements) {
                  element?.[reportParentshipSymbol]?.(init.owner, init.fieldName);
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
            trackModification(self, ACCESS_ALL_SYMBOL);

            // Clear parent tracking for all items
            if (init.list && init.isChildField) {
              for (const item of target) {
                item?.[reportOrphanSymbol]?.();
              }
            }

            target.splice(0, target.length);
            if (init.list) {
              // Clear existing contents
              init.list.delete(0, init.list.length);
            }
          };
        case "assign": // arr.assign(newElements) → replace entire array contents
          // eslint-disable-next-line sonarjs/no-nested-functions
          return (newElements: Array<ModelPattern | null>) => {
            trackModification(self, ACCESS_ALL_SYMBOL);
            maybeTransacting(init.list?.doc, () => {
              if (init.isChildField) {
                // todo duplicate models detection
                // Clear parent tracking for old items
                const removedItems = new Set(target).difference(new Set(newElements));
                const addedItems = new Set(newElements).difference(new Set(target));
                for (const item of removedItems) {
                  item?.[reportOrphanSymbol]?.();
                }
                for (const item of addedItems) {
                  item?.[reportParentshipSymbol]?.(init.owner, init.fieldName);
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
                trackModification(self, ACCESS_ALL_SYMBOL);
                // if (!mutableArrayMethodsPreservingLength.has(elementKey)) {
                //   trackModification(self, ACCESS_INDICES_SET_SYMBOL);
                // }
                if (!init.list) {
                  return target[elementKey](...args);
                }
                maybeTransacting(init.list?.doc, () => {
                  const array = init.list.toArray().map((item) => deref(init.list.doc!, item));
                  const result = array[elementKey](...args);

                  // todo duplicate models detection
                  // Clear parent tracking for old items
                  const removedItems = new Set(target).difference(new Set(result));
                  const addedItems = new Set(result).difference(new Set(target));
                  for (const item of removedItems) {
                    item?.[reportOrphanSymbol]?.();
                  }
                  for (const item of addedItems) {
                    item?.[reportParentshipSymbol]?.(init.owner, init.fieldName);
                  }

                  init.list.doc!.transact(() => {
                    // todo optimized update strategy
                    init.list.delete(0, init.list.length);
                    init.list.push(array.map(init.boundMaybeReference));
                  });
                  return result;
                });
              }
            : // eslint-disable-next-line sonarjs/no-nested-functions
              (...args) => {
                if (!init.list) {
                  return target[elementKey](...args);
                }
                // Non-mutating array methods that iterate over all elements
                trackAccess(self, ACCESS_ALL_SYMBOL);
                return init.list
                  .toArray()
                  .map((item) => deref(init.list.doc!, item))
                  [elementKey](...args);
              };
        } else {
          // Report keyset access to this array for Array.prototype property access
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
      trackModification(self, elementKey);
      if (elementKey === "length") {
        trackModification(self, ACCESS_ALL_SYMBOL);
        // Handle array length truncation
        const newLength = Number(value);
        if (Number.isSafeInteger(newLength) && newLength >= 0) {
          if (!init.list) {
            for (const item of target) {
              item?.[reportOrphanSymbol]?.();
            }
            target.length = newLength;
            return true;
          }
          if (newLength < init.list.length) {
            // eslint-disable-next-line sonarjs/no-nested-functions
            init.list.doc!.transact(() => {
              // Clear parent tracking for truncated items
              if (init.isChildField) {
                for (const item of target) {
                  item?.[reportOrphanSymbol]?.();
                }
              }

              init.list.delete(newLength, init.list.length - newLength);
            });
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

            // Handle parent tracking for replaced item
            if (init.isChildField) {
              // Clear parent for old item at this index
              if (parsedElementKey < init.list.length) {
                target[parsedElementKey]?.[reportOrphanSymbol]?.();
              }

              // Update parent for new item
              if (value) {
                value?.[reportOrphanSymbol]?.();
              }
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
              init.list.doc!.transact(() => {
                init.list.delete(parsedElementKey, 1);
                init.list.insert(parsedElementKey, [init.boundMaybeReference(value)]);
              });
            }
          }
          return true;
        }
      }
      console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
      return false;
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
      trackAccess(self, ACCESS_ALL_SYMBOL);
      return Reflect.ownKeys(init.list?.toArray() ?? target);
    },
  });
  listProxyInitMap.set(self, init);
  return self;
};
