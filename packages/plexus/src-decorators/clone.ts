import { informAdoptionSymbol, isProxyEntity, LegitimateSchema, type ModelType } from "./proxy-runtime-types";
import { ACCESS_ALL_SYMBOL, trackAccess } from "./tracking";
import { isModelType } from "./utils";
import { PlexusModel } from "./PlexusModel";

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

function maybeClone<T>(object: T, parent: PlexusModel, parentField: string, metadata?: string): T {
  if (object instanceof PlexusModel) {
    const clonedObject = object.clone() as T;
    clonedObject[informAdoptionSymbol](parent, parentField, metadata);
    return clonedObject;
  } else {
    return object;
  }
}

export function clone<Model extends PlexusModel>(
  source: Model,
  newProps: Partial<Model> = {}
) {
  const isTopLevel = cloneTransactionMapping === null;
  cloneTransactionMapping ??= new WeakMap();
  if (cloneTransactionMapping.has(source)) {
    return cloneTransactionMapping.get(source);
  }
  try {
    trackAccess(source, ACCESS_ALL_SYMBOL);
    // @ts-expect-error we're bypassing ts constraints here as we're aware on underlying js logic
    const clonedModel = new source.constructor();
    cloneTransactionMapping.set(source, clonedModel);
    // it is important to not reuse the existing primitives: we have different logic based on child/non-child fields
    for (const [fieldKey, type] of Object.entries(source._schema)) {
      const fieldValue = fieldKey in newProps ? newProps[fieldKey] : source[fieldKey];
      if (fieldValue && fieldValue[isProxyEntity]) {
        trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
      }
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
          clonedModel[fieldKey] = maybeClone(fieldValue, clonedModel, fieldKey);
          break;
        case "child-list":
          clonedModel[fieldKey].assign(
            (fieldValue as any as any[]).map((item) => maybeClone(item, clonedModel as any, fieldKey))
          );
          break;
        case "child-set":
          clonedModel[fieldKey].assign(
            new Set([...(fieldValue as any as Set<any>)].map((item) => maybeClone(item, clonedModel as any, fieldKey)))
          );
          break;
        case "child-record":
          clonedModel[fieldKey].assign(
            Object.fromEntries(
              Object.entries(fieldValue as Record<string, any>).map(([key, item]) => [
                key,
                maybeClone(item, clonedModel as any, fieldKey, key)
              ])
            )
          );
          break;
      }
    }
    return clonedModel;
  } finally {
    if (isTopLevel) {
      cloneTransactionMapping = null;
    }
  }
}
