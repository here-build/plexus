import type { ModelConstructor } from "./proxy-runtime-types";
import * as Y from "yjs";
import { DefaultedWeakMap } from "./utils";
import { PlexusConstructor, PlexusModel } from "./PlexusModel";

export const entityClasses = new Map<string, PlexusConstructor>();
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
export const documentEntityCaches = new DefaultedWeakMap<Y.Doc, Map<string, WeakRef<PlexusModel>>>(
  () => new Map<string, WeakRef<PlexusModel>>()
);
