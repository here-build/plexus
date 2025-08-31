import type { ModelConstructor, ModelPattern } from "./proxy-runtime-types";
import * as Y from "yjs";
import { DefaultedWeakMap } from "./utils";

export const entityClasses = new Map<string, ModelConstructor<{}, string>>();
export const mutableArrayMethods = new Set<symbol | string>([
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice"
]);
export const mutableArrayMethodsPreservingLength = new Set<symbol | string>(["fill", "reverse", "sort"]);
// Entity cache
export const documentEntityCaches = new DefaultedWeakMap<Y.Doc, Map<string, WeakRef<ModelPattern>>>(
  () => new Map<string, WeakRef<ModelPattern>>()
);
