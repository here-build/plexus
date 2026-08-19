import { isFrameLike } from "./guards.js";
import type { ExcalidrawAnyElement } from "./types.js";

/**
 * Depth-first over the ownership tree. Frames yield before their children, so
 * callers that need Excalidraw's children-before-frame paint order reverse it
 * themselves — see `orderForView`.
 */
export function* walk(nodes: readonly ExcalidrawAnyElement[]): Generator<ExcalidrawAnyElement> {
  for (const n of nodes) {
    yield n;
    if (isFrameLike(n)) yield* walk(n.children);
  }
}
