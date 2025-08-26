import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  isProxyEntity,
  ModelPattern,
  ModelType,
  referenceSymbol,
  ReferenceTuple
} from "../proxy-runtime-types";

// Simple default implementations for missing dependencies
export class DefaultedMap<K, V> extends Map<K, V> {
  constructor(private factory: (key: K) => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory(key));
    }
    return super.get(key)!;
  }
}

export class DefaultedWeakMap<K extends object, V> extends WeakMap<K, V> {
  constructor(private factory: (key: K) => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory(key));
    }
    return super.get(key)!;
  }
}

export function never(value: never): never {
  debugger;
  throw new Error(`Unexpected value: ${value}`);
}

export const isModelType = (object: any): object is ModelType<{}, string> => object?.[isProxyEntity] as boolean;

const isModel = (val: any): val is ModelPattern => val && typeof val === "object" && referenceSymbol in val;

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length >= 1 && val.length <= 2 && typeof val[0] === "string";

export const definitelyReference = (val: ModelPattern, projectId: string, doc: Y.Doc): AllowedYValue =>
  val[referenceSymbol](projectId, doc);

export const maybeReference = (val: AllowedYJSValue, projectId?: string, doc?: Y.Doc): AllowedYValue =>
  (projectId && doc && isModel(val) ? val[referenceSymbol](projectId, doc) : val) ?? null;

export const curryMaybeReference =
  (projectId: string, doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    (isModel(val) ? val[referenceSymbol](projectId, doc) : val) ?? null;
