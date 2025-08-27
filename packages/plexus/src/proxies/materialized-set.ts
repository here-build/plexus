import * as Y from "yjs";
import { AllowedYJSValue, AllowedYValue, materializationSymbol } from "../proxy-runtime-types";
import { curryMaybeReference } from "../utils";
import { ACCESS_ALL_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";

export type MaterializedSetProxyInitTarget =
  | {
      list: Y.Array<AllowedYValue>;
      boundMaybeReference: ReturnType<typeof curryMaybeReference>;
    }
  | {
      list?: undefined;
      boundMaybeReference?: undefined;
    };

export const setProxyInitMap = new Map<Set<any>, MaterializedSetProxyInitTarget>();

export const buildSetProxy = (init: MaterializedSetProxyInitTarget, target: Set<AllowedYJSValue> = new Set()) => {
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    // todo add adjustments like in record
    trackModification(self, ACCESS_ALL_SYMBOL)
  }
  init.list?.observe(observer)

  const self = new Proxy(Object.seal(new Set()), {
    get(_, elementKey) {
      switch (elementKey) {
        case "size":
          return init.list?.length ?? target.size;
        case "add":
          return (value: AllowedYJSValue) => {
            // here and below we're using deref and not boundRef to ensure that entities are unique,
            // allowing us to directly compare instead of structural checks
            if (!init.list) {
              if (!target.has(value)) {
                trackModification(self, ACCESS_ALL_SYMBOL);
              }
              return target.add(value);
            }
            if (
              !init.list
                .toArray()
                .map((item) => deref(init.list.doc!, item))
                .includes(value)
            ) {
              trackModification(self, ACCESS_ALL_SYMBOL);
              init.list.doc!.transact(() => {
                init.list.push([init.boundMaybeReference(value)]);
              });
              return true;
            }

            return false;
          };
        case "clear":
          return () => {
            if (!init.list) {
              if (target.size > 0) {
                trackModification(self, ACCESS_ALL_SYMBOL);
              }
              return target.clear();
            }
            const outputLength = init.list.length;
            if (outputLength === 0) {
              return 0;
            }
            trackModification(self, ACCESS_ALL_SYMBOL);
            if (init.list) {
              init.list.doc!.transact(() => {
                init.list.delete(0, outputLength);
              });
            }
            return outputLength;
          };
        case "assign":
          return (newValues: Iterable<AllowedYJSValue>) => {
            trackModification(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              target.clear();
              target = new Set(newValues);
              return;
            }
            init.list.doc!.transact(() => {
              // Clear existing contents
              init.list?.delete(0, init.list.length);
              // Add new values
              for (const value of newValues) {
                if (
                  !init.list
                    .toArray()
                    .map((item) => deref(init.list.doc!, item))
                    .includes(value)
                ) {
                  init.list.push([init.boundMaybeReference(value)]);
                }
              }
            });
          };
        case "delete":
          return (value: AllowedYJSValue) => {
            if (!init.list) {
              if (target.delete(value)) {
                trackModification(self, ACCESS_ALL_SYMBOL);
                return true;
              }
              return false;
            }
            const index = init.list
              .toArray()
              .map((item) => deref(init.list.doc!, item))
              .indexOf(value);
            if (index === -1) {
              return false;
            }
            init.list.doc!.transact(() => {
              init.list.delete(index, 1);
            });
            trackModification(self, ACCESS_ALL_SYMBOL);
            return true;
          };
        case "entries":
          return () => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.entries();
            }
            return init.list
              .toArray()
              .map((item) => deref(init.list.doc!, item))
              .map((v) => [v, v]);
          };
        case "values":
        case "keys":
          return () => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.values();
            }
            return init.list.toArray().map((item) => deref(init.list.doc!, item));
          };
        case Symbol.iterator:
          return () => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              // todo this may theoretically cause problems for dynamic iteration logic when CRDT kicks in
              return target[Symbol.iterator]();
            }
            return init.list
              .toArray()
              .map((item) => deref(init.list.doc!, item))
              [Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Set";
        case "forEach":
          return (
            callbackfn: (value: AllowedYJSValue, value2: AllowedYJSValue, set: Set<AllowedYJSValue>) => void,
            thisArg?: any
          ) => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.forEach(callbackfn, thisArg);
            }
            return new Set(init.list.toArray().map((item) => deref(init.list.doc!, item))).forEach(callbackfn, thisArg);
          };
        case "has":
          return (value: AllowedYJSValue) => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.has(value);
            }
            return init.list
              .toArray()
              .map((item) => deref(init.list.doc!, item))
              .includes(value);
          };
        case "intersection":
          throw new Error("not implemented yet");
        case "isDisjointFrom":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.isDisjointFrom(set);
            }
            return new Set(init.list.toArray().map((item) => deref(init.list.doc!, item))).isDisjointFrom(set);
          };
        case "isSubsetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.isSubsetOf(set);
            }
            return new Set(init.list.toArray().map((item) => deref(init.list.doc!, item))).isSubsetOf(set);
          };
        case "isSupersetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!init.list) {
              return target.isSupersetOf(set);
            }
            return new Set(init.list.toArray().map((item) => deref(init.list.doc!, item))).isSupersetOf(set);
          };
        case materializationSymbol:
          return (struct: Y.Array<AllowedYValue>, boundMaybeReference: ReturnType<typeof curryMaybeReference>) => {
            init.list?.unobserve(observer)
            init.list = struct;
            init.boundMaybeReference = boundMaybeReference;
            init.list.observe(observer)
          }
        default:
          return false;
      }
    }
  });
  setProxyInitMap.set(self, init);
  return self;
};
