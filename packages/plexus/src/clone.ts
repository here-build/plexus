import {
  type AllowedYJSValue,
  LegitimateSchema,
  ModelConstructorInit,
  type ModelType,
  informAdoptionSymbol
} from "./proxy-runtime-types";
import { ACCESS_ALL_SYMBOL, trackAccess } from "./tracking";
import { isModelType } from "./utils";

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

function maybeClone<T>(object: T, parent: ModelType<{}, string>, parentField: string, metadata?: string): T {
  if (isModelType(object)) {
    const clonedObject = object.clone() as T;
    clonedObject[informAdoptionSymbol](parent, parentField, metadata)
    return clonedObject;
  } else {
    return object;
  }
}

export function clone<State extends LegitimateSchema<State>, Name extends string>(
  source: ModelType<State, Name>,
  newProps?: Partial<State>
) {
  const isTopLevel = cloneTransactionMapping === null;
  cloneTransactionMapping ??= new WeakMap();
  if (cloneTransactionMapping.has(source)) {
    return cloneTransactionMapping.get(source);
  }
  try {
    trackAccess(source, ACCESS_ALL_SYMBOL);
    // @ts-expect-error we're bypassing ts constraints here as we're aware on underlying js logic
    const clonedModel = new source.constructor({});
    cloneTransactionMapping.set(source, clonedModel);
    for (const [fieldKey, type] of Object.entries(source.constructor.schema)) {
      const fieldValue = source[fieldKey as keyof typeof source];
      trackAccess(fieldValue, ACCESS_ALL_SYMBOL)
      switch (type) {
        case "val":
          // @ts-expect-error "generic and can be only used for indexing"
          clonedModel[fieldKey] = fieldValue;
          break;
        case "list":
        case "record":
        case "set":
          // @ts-expect-error "generic and can be only used for indexing"
          clonedModel[fieldKey].assign(fieldValue);
          break;
        case "child-val": // @ts-expect-error "generic and can be only used for indexing"
          clonedModel[fieldKey] = maybeClone(fieldValue, clonedModel, fieldKey);
          break;
        case "child-list": // @ts-expect-error "generic and can be only used for indexing"
          clonedModel[fieldKey].assign(
            (fieldValue as any as any[]).map((item) => maybeClone(item, clonedModel as any, fieldKey))
          );
          break;
        case "child-set": // @ts-expect-error "generic and can be only used for indexing"
          clonedModel[fieldKey].assign(
            new Set([...(fieldValue as any as Set<any>)].map((item) => maybeClone(item, clonedModel as any, fieldKey)))
          );
          break;
        case "child-record": // @ts-expect-error "generic and can be only used for indexing"
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
