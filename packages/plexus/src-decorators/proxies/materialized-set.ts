import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  informOrphanizationSymbol,
  materializationSymbol,
  ReadonlyField,
  requestAdoptionSymbol
} from "../proxy-runtime-types";
import { maybeReference, maybeTransacting } from "../utils";
import { ACCESS_ALL_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";
import { PlexusModel } from "../PlexusModel";

export type MaterializedSetProxyInitTarget<T extends AllowedYJSValue> =
  {
    owner: PlexusModel;
    context: ClassAccessorDecoratorContext<PlexusModel, Set<T>> & { name: string };
    isChildField?: boolean;
  };

export const buildSetProxy = <T extends AllowedYJSValue>({ owner, context, isChildField }: MaterializedSetProxyInitTarget<T>) => {
  let backingSet = new Set<T>();
  let needsRegeneration = false;
  const getBackgingSet = () => {
    if (needsRegeneration) {
      needsRegeneration = false;
      backingSet = new Set(getYjsSet()!.toArray().map((item) => deref(owner._doc!, item) as T));
    }
    return backingSet;
  }
  const getYjsSet = () => owner._yjsModel?.get(context.name) as Y.Array<AllowedYValue> | null;
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    if (event.target !== getYjsSet()) {
      return;
    }
    needsRegeneration = true;
    // todo narrowed observer event triggers
    trackModification(self, ACCESS_ALL_SYMBOL);
  };
  getYjsSet()?.observe(observer);


  const self = new Proxy(Object.seal(backingSet), {
    get(_, elementKey) {
      switch (elementKey) {
        case "size":
          return getYjsSet()?.length ?? getBackgingSet().size;
        case "add":
          return (value: T) => {
            const yjsArray = getYjsSet();
            // here and below we're using deref and not boundRef to ensure that entities are unique,
            // allowing us to directly compare instead of structural checks
            if (!yjsArray) {
              const hadValue = getBackgingSet().has(value);
              if (!hadValue) {
                backingSet.add(value);
                trackModification(self, ACCESS_ALL_SYMBOL);
              }
              return self;
            }
            if (!getBackgingSet().has(value)) {
              maybeTransacting(owner._doc!, () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
                // Update parent tracking for child fields
                if (isChildField) {
                  value?.[requestAdoptionSymbol]?.(owner, context.name);
                }

                yjsArray?.push([maybeReference(value, owner._doc!)]);
              });
              return true;
            }

            return false;
          };
        case "clear":
          return () => {
            const yjsArray = getYjsSet();
            if (!yjsArray) {
              const set = getBackgingSet()
              const wasEmpty = set.size === 0;
              set.clear();
              if (!wasEmpty) {
                trackModification(self, ACCESS_ALL_SYMBOL);
              }
              return;
            }
            const outputLength = yjsArray.length;
            if (outputLength === 0) {
              return 0;
            }
            maybeTransacting(owner._doc!, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for all items
              if (isChildField) {
                const items = yjsArray.toArray().map((item) => deref(owner._doc!, item));
                for (const item of items) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }

              yjsArray.delete(0, outputLength);
            });
            return outputLength;
          };
        case "assign":
          return (newValues: Iterable<T>) => {
            const yjsArray = getYjsSet();
            if (!yjsArray) {
              backingSet.clear();
              backingSet = new Set(newValues);
              trackModification(self, ACCESS_ALL_SYMBOL);
              return;
            }

            maybeTransacting(owner._doc, () => {
              trackModification(self, ACCESS_ALL_SYMBOL);
              // Clear parent tracking for old items
              if (isChildField) {
                const oldItems = yjsArray.toArray().map((item) => deref(owner._doc!, item));
                for (const item of oldItems) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }

              // Clear existing contents
              yjsArray?.delete(0, yjsArray.length);
              // Add new values
              for (const value of newValues) {
                if (
                  !yjsArray
                    .toArray()
                    .map((item) => deref(owner._doc!, item))
                    .includes(value)
                ) {
                  // Update parent tracking for new items
                  if (isChildField) {
                    value?.[requestAdoptionSymbol]?.(owner, context.name);
                  }
                  yjsArray.push([maybeReference(value, owner._doc!)]);
                }
              }
            });
          };
        case "delete":
          return (value: T) => {
            const yjsArray = getYjsSet();
            if (!yjsArray) {
              if (backingSet.delete(value)) {
                trackModification(self, ACCESS_ALL_SYMBOL);
                return true;
              }
              return false;
            }
            const index = yjsArray
              .toArray()
              .map((item) => deref(owner._doc!, item))
              .indexOf(value);
            if (index === -1) {
              return false;
            }

            maybeTransacting(owner._doc, () => {
              // Clear parent tracking for removed item
              if (isChildField) {
                value?.[informOrphanizationSymbol]?.();
              }

              yjsArray.delete(index, 1);
            });
            trackModification(self, ACCESS_ALL_SYMBOL);
            return true;
          };
        case "entries":
          return () => {
            const yjsArray = getYjsSet();
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            if (!yjsArray) {
              return getBackgingSet().entries();
            }
            return yjsArray
              .toArray()
              .map((item) => deref(owner._doc!, item))
              .map((v) => [v, v]);
          };
        case "values":
        case "keys":
          return () => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().values();
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet()[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Set";
        case "forEach":
          return (
            callbackfn: (value: T, value2: T, set: Set<T>) => void,
            thisArg?: any
          ) => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().forEach(callbackfn, thisArg);
          };
        case "has":
          return (value: T) => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().has(value);
          };
        case "intersection":
          throw new Error("not implemented yet");
        case "isDisjointFrom":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isDisjointFrom(set);
          };
        case "isSubsetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isSubsetOf(set);
          };
        case "isSupersetOf":
          return (set: Set<AllowedYJSValue>) => {
            trackAccess(owner, context.name);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return getBackgingSet().isSupersetOf(set);
          };
        case materializationSymbol:
          return () => {
            // todo duplicate observation tracking
            getYjsSet()!.observe(observer);
          };
        default:
          return false;
      }
    }
  });
  return self as Set<T> & ReadonlyField<Set<T>>;
};
