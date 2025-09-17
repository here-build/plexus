import { PlexusConstructor } from "./PlexusModel";

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
