import * as Y from "yjs";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { AllowedYJSValue, AllowedYValue, ModelPattern } from "../proxy-runtime-types";
import { curryMaybeReference, maybeReference } from "../utils";
import { deref } from "../deref";
import { mutableArrayMethods } from "../globals";

export type MaterializedArrayProxyInitTarget = {
  doc: Y.Doc;
  projectId: string;
  type: string;
  arrayProxy: AllowedYJSValue[];
  list: Y.Array<AllowedYValue>;
  boundMaybeReference: ReturnType<typeof curryMaybeReference>;
}

export const materializedArrayProxyInit: ProxyHandler<MaterializedArrayProxyInitTarget> = {
  // eslint-disable-next-line sonarjs/cognitive-complexity
  get({ projectId, arrayProxy, doc, list }, elementKey) {
    // MUTATING ARRAY METHODS: Convert entities to references, sync to YJS
    switch (elementKey) {
      case "push":
        // arr.push(entity) → yArray.push(entity.reference())
        // eslint-disable-next-line sonarjs/no-nested-functions
        return (...elements: Array<ModelPattern | null>) => {
          trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
          list.push(elements.map((element) => maybeReference(element, projectId, doc)));
          return list.length;
        };
      case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
        // eslint-disable-next-line sonarjs/no-nested-functions
        return (...elements: Array<ModelPattern | null>) => {
          trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
          list.unshift(elements.map((element) => maybeReference(element, projectId, doc)));
          return list.length;
        };
      case "clear": // arr.assign(newElements) → replace entire array contents
        // eslint-disable-next-line sonarjs/no-nested-functions
        return () => {
          trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
          // Clear existing contents
          list.delete(0, list.length);
        };
      case "assign": // arr.assign(newElements) → replace entire array contents
        // eslint-disable-next-line sonarjs/no-nested-functions
        return (newElements: Array<ModelPattern | null>) => {
          trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
          // Clear existing contents
          list.delete(0, list.length);
          // Add new elements
          list.push(newElements.map((element) => maybeReference(element, projectId, doc)));
        };
      case "length": // Report length access to this array
        trackAccess(arrayProxy, ACCESS_INDICES_SET_SYMBOL);

        return list.length;
    }

    // Well-known Symbol support
    if (typeof elementKey === "symbol") {
      switch (elementKey) {
        case Symbol.iterator:
          return () => {
            trackAccess(arrayProxy, ACCESS_ALL_SYMBOL);
            return list
              .toArray()
              .map((item) => deref(doc, item))
              [Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Array";
        case Symbol.isConcatSpreadable:
          return true;
      }
    }

    // eslint-disable-next-line sonarjs/no-in-misuse
    if (elementKey in Array.prototype) {
      if (typeof Array.prototype[elementKey] === "function") {
        return mutableArrayMethods.has(elementKey)
          ? // eslint-disable-next-line sonarjs/no-nested-functions
            (...args) => {
              trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
              // if (!mutableArrayMethodsPreservingLength.has(elementKey)) {
              //   trackModification(arrayProxy, ACCESS_INDICES_SET_SYMBOL);
              // }
              const array = list.toArray().map((item) => deref(doc, item));
              const result = array[elementKey](...args);

              doc.transact(() => {
                // todo optimized update strategy
                list.delete(0, list.length);
                list.push(array.map((element) => maybeReference(element, projectId, doc)));
              });
              return result;
            }
          : // eslint-disable-next-line sonarjs/no-nested-functions
            (...args) => {
              // Non-mutating array methods that iterate over all elements
              trackAccess(arrayProxy, ACCESS_ALL_SYMBOL);
              return list
                .toArray()
                .map((item) => deref(doc, item))
                [elementKey](...args);
            };
      } else {
        // Report keyset access to this array for Array.prototype property access
        trackAccess(arrayProxy, elementKey);
        return Array.prototype[elementKey];
      }
    }
    // ARRAY ELEMENT ACCESS: arr[0] → deref(yArray.get(0))
    // Converts YJS References back to live entity objects
    if (typeof elementKey === "string") {
      const parsedElementKey = Number.parseInt(elementKey);
      if (Number.isSafeInteger(parsedElementKey)) {
        // Report specific index access
        trackAccess(arrayProxy, elementKey);
        return deref(doc, list.get(parsedElementKey)); // Reference → live entity
      }
    }
  },
  // eslint-disable-next-line sonarjs/cognitive-complexity
  set({ doc, projectId, type, arrayProxy, list, boundMaybeReference }, elementKey, value) {
    const docProjectId = doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.projectId);
    if (projectId !== docProjectId) {
      console.warn(`cannot set property ${elementKey.toString()} of ${type} as it's readonly dependency reference`);
      return false;
    }
    trackModification(arrayProxy, elementKey);
    if (elementKey === "length") {
      trackModification(arrayProxy, ACCESS_ALL_SYMBOL);
      // Handle array length truncation
      const newLength = Number(value);
      if (Number.isSafeInteger(newLength) && newLength >= 0) {
        if (newLength < list.length) {
          // eslint-disable-next-line sonarjs/no-nested-functions
          doc.transact(() => {
            list.delete(newLength, list.length - newLength);
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
          console.warn(`cannot set ${type}[${parsedElementKey}] as it's below zero`);
          return false;
        } else if (parsedElementKey > list.length) {
          // eslint-disable-next-line sonarjs/no-nested-functions
          const postfix: null[] = [];
          while (postfix.length + list.length < parsedElementKey - 1) {
            postfix.push(null);
          }
          list.push([...postfix, boundMaybeReference(value)]);
        } else {
          // eslint-disable-next-line sonarjs/no-nested-functions
          doc.transact(() => {
            list.delete(parsedElementKey, 1);
            list.insert(parsedElementKey, [boundMaybeReference(value)]);
          });
        }
        return true;
      }
    }
    console.warn(`cannot set property ${elementKey.toString()} of ${type} as it's non-declared`);
    return false;
  },
  deleteProperty() {
    return false;
  },
  // todo getOwnPropertyDescriptor
  setPrototypeOf() {
    return false;
  },
  has({ list }, elementKey) {
    if (elementKey === "length") {
      return true;
    }
    if (typeof elementKey === "string") {
      const parsedElementKey = Number.parseInt(elementKey);
      if (Number.isSafeInteger(parsedElementKey)) {
        return parsedElementKey >= 0 && parsedElementKey < list.length;
      }
    }
    // eslint-disable-next-line sonarjs/no-in-misuse
    return elementKey in Array.prototype;
  },
  ownKeys({ list, arrayProxy }) {
    trackAccess(arrayProxy, ACCESS_ALL_SYMBOL);
    return Reflect.ownKeys(list.toArray());
  },
  getPrototypeOf() {
    return Array.prototype;
  },
  isExtensible(): boolean {
    return true;
  }
};
