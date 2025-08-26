import { type AllowedYJSValue, LegitimateSchema, ModelConstructorInit, type ModelType } from "./proxy-runtime-types";
import { ACCESS_ALL_SYMBOL, trackAccess } from "./tracking";
import { isModelType } from "./utils";

// Global clone transaction mapping for handling cycles and deduplication
let cloneTransactionMapping: WeakMap<any, any> | null = null;

function maybeClone<T>(object: T): T {
  if (isModelType(object)) {
    return object.clone() as T;
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
    const constructorInit = Object.fromEntries(
      Object.entries(source.constructor.schema).map(([fieldKey, type]) => {
        const fieldValue = source[fieldKey as keyof typeof source];
        if (type === "val") {
          // Primitive value or reference - copy directly
          return [fieldKey, newProps?.[fieldKey] ?? (fieldValue as AllowedYJSValue)];
        } else if (type === "list") {
          trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
          // Regular list - shallow clone collection
          return [fieldKey, [...((newProps?.[fieldKey] ?? fieldValue) as any)]];
        } else if (type === "set") {
          trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
          return [fieldKey, new Set((newProps?.[fieldKey] ?? fieldValue) as any)];
        } else if (type === "record") {
          trackAccess(fieldValue, ACCESS_ALL_SYMBOL);
          return [fieldKey, newProps?.[fieldKey] ? { ...(newProps?.[fieldKey] as any) } : { ...(fieldValue as any) }];
        } else {
          // we intentionally skip child-* on this step as otherwise it will be impossible to implement circular references in cloning properly
          return [fieldKey, null];
        }
      })
    ) as ModelConstructorInit<State, Name>;
    const clonedModel = new source.constructor(constructorInit);
    cloneTransactionMapping.set(source, clonedModel);
    for (const [fieldKey, type] of Object.entries(source.constructor.schema)) {
      const fieldValue = source[fieldKey as keyof typeof source];

      if (type === "child-val") {
        // @ts-expect-error "generic and can be only used for indexing"
        clonedModel[fieldKey] = maybeClone(fieldValue);
      } else if (type === "child-list") {
        // @ts-expect-error "generic and can be only used for indexing"
        clonedModel[fieldKey].assign((fieldValue as any as any[]).map(maybeClone));
      } else if (type === "child-set") {
        // @ts-expect-error "generic and can be only used for indexing"
        clonedModel[fieldKey].assign(new Set([...(fieldValue as any as Set<any>)].map(maybeClone)));
      } else if (type === "child-record") {
        // @ts-expect-error "generic and can be only used for indexing"
        clonedModel[fieldKey].assign(
          Object.fromEntries(
            Object.entries(fieldValue as Record<string, any>).map(([key, item]) => [key, maybeClone(item)])
          )
        );
      }
    }
    return clonedModel;
  } finally {
    if (isTopLevel) {
      cloneTransactionMapping = null;
    }
  }
}
