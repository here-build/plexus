import * as Y from "yjs";
import { AllowedYJSValue, AllowedYValue } from "../proxy-runtime-types";
import { curryMaybeReference } from "../utils";
import { ACCESS_ALL_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";

export type MaterializedSetProxyInitTarget = {
  doc: Y.Doc;
  projectId: string;
  type: string;
  setProxy: Set<AllowedYJSValue>;
  list: Y.Array<AllowedYValue>;
  boundMaybeReference: ReturnType<typeof curryMaybeReference>;
};

export const materializedSetProxyInit: ProxyHandler<MaterializedSetProxyInitTarget> = {
  get({ list, doc, setProxy, boundMaybeReference }, elementKey) {
    switch (elementKey) {
      case "size":
        return list.length;
      case "add":
        return (value: AllowedYJSValue) => {
          // here and below we're using deref and not boundRef to ensure that entities are unique,
          // allowing us to directly compare instead of structural checks
          if (
            !list
              .toArray()
              .map((item) => deref(doc, item))
              .includes(value)
          ) {
            trackModification(setProxy, ACCESS_ALL_SYMBOL);
            list.push([boundMaybeReference(value)]);
            return true;
          }
          return false;
        };
      case "clear":
        return () => {
          const outputLength = list.length;
          if (outputLength === 0) {
            return 0;
          }
          trackModification(setProxy, ACCESS_ALL_SYMBOL);
          list?.delete(0, outputLength);
          return outputLength;
        };
      case "assign":
        return (newValues: Iterable<AllowedYJSValue>) => {
          trackModification(setProxy, ACCESS_ALL_SYMBOL);
          // Clear existing contents
          list?.delete(0, list.length);
          // Add new values
          for (const value of newValues) {
            if (
              !list
                .toArray()
                .map((item) => deref(doc, item))
                .includes(value)
            ) {
              list.push([boundMaybeReference(value)]);
            }
          }
        };
      case "delete":
        return (value: AllowedYJSValue) => {
          const index = list
            .toArray()
            .map((item) => deref(doc, item))
            .indexOf(value);
          if (index === -1) {
            return false;
          }
          list.delete(index, 1);
          trackModification(setProxy, ACCESS_ALL_SYMBOL);
          return true;
        };
      case "entries":
        return () => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return list
            .toArray()
            .map((item) => deref(doc, item))
            .map((v) => [v, v]);
        };
      case "values":
      case "keys":
        return () => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return list.toArray().map((item) => deref(doc, item));
        };
      case Symbol.iterator:
        return () => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return list
            .toArray()
            .map((item) => deref(doc, item))
            [Symbol.iterator]();
        };
      case Symbol.toStringTag:
        return "Set";
      case "forEach":
        return (
          callbackfn: (value: AllowedYJSValue, value2: AllowedYJSValue, set: Set<AllowedYJSValue>) => void,
          thisArg?: any
        ) => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return new Set(list.toArray().map((item) => deref(doc, item))).forEach(callbackfn, thisArg);
        };
      case "has":
        return (value: AllowedYJSValue) => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return list
            .toArray()
            .map((item) => deref(doc, item))
            .includes(value);
        };
      case "intersection":
        throw new Error("not implemented yet");
      case "isDisjointFrom":
        return (set: Set<AllowedYJSValue>) => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return new Set(list.toArray().map((item) => deref(doc, item))).isDisjointFrom(set);
        };
      case "isSubsetOf":
        return (set: Set<AllowedYJSValue>) => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return new Set(list.toArray().map((item) => deref(doc, item))).isSubsetOf(set);
        };
      case "isSupersetOf":
        return (set: Set<AllowedYJSValue>) => {
          trackAccess(setProxy, ACCESS_ALL_SYMBOL);
          return new Set(list.toArray().map((item) => deref(doc, item))).isSupersetOf(set);
        };
      default:
        return false;
    }
  },
  set() {
    throw new Error("cannot set properties to syncing Set");
  },
  deleteProperty() {
    throw new Error("cannot set properties to syncing Set");
  },
  has() {
    return false;
  },
  ownKeys() {
    return [];
  },
  getPrototypeOf() {
    return Set.prototype;
  },
  isExtensible(): boolean {
    return false;
  }
};
