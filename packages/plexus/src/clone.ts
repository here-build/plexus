import { isProxyEntity } from "./proxy-runtime-types";
import { __untracked__, ACCESS_ALL_SYMBOL, trackAccess } from "./tracking";
import { ConcretePlexusConstructor, PlexusModel } from "./PlexusModel";

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

export function clone<Model extends PlexusModel>(source: Model, newProps: Partial<Model> = {}) {
  const isTopLevel = cloneTransactionMapping === null;
  cloneTransactionMapping ??= new WeakMap();
  if (cloneTransactionMapping.has(source)) {
    return cloneTransactionMapping.get(source);
  }
  try {
    trackAccess(source, ACCESS_ALL_SYMBOL);
    // this is vital to not pass anything at all during that phase. we need to first register cloned entity
    // in cloneTransactionMapping, then assign values to solve circular dependencies
    const clonedModel = new (source.constructor as ConcretePlexusConstructor)();
    cloneTransactionMapping.set(source, clonedModel);
    // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
    for (const [fieldKey, type] of Object.entries(source._schema)) {
      const fieldValue = fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
      if (fieldValue && fieldValue[isProxyEntity]) {
        trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
      }
      __untracked__(() => {
        switch (type) {
          case "val":
            clonedModel[fieldKey] = fieldValue;
            break;
          case "list":
          case "record":
          case "set":
            clonedModel[fieldKey].assign(fieldValue);
            break;
          case "child-val":
            const clonedValue = fieldValue instanceof PlexusModel ? fieldValue.clone() : fieldValue;
            clonedModel[fieldKey] = clonedValue;
            break;
          case "child-list":
            clonedModel[fieldKey].assign(
              (fieldValue as any as any[]).map((item) => (item instanceof PlexusModel ? item.clone() : item))
            );
            break;
          case "child-set":
            clonedModel[fieldKey].assign(
              new Set(
                [...(fieldValue as any as Set<any>)].map((item) => (item instanceof PlexusModel ? item.clone() : item))
              )
            );
            break;
          case "child-record":
            clonedModel[fieldKey].assign(
              Object.fromEntries(
                Object.entries(fieldValue as Record<string, any>).map(([key, item]) => [
                  key,
                  item instanceof PlexusModel ? item.clone() : item
                ])
              )
            );
            break;
        }
      });
    }
    return clonedModel;
  } finally {
    if (isTopLevel) {
      cloneTransactionMapping = null;
    }
  }
}
