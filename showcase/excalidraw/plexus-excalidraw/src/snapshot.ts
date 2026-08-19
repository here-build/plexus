import type * as X from "@excalidraw/excalidraw/element/types";
import {
  isFrameLike,
  walk,
  type ExcalidrawAnyElement,
  type Scene,
} from "@here.build/plexus-excalidraw-models";

/**
 * Flatten the ownership tree into the array Excalidraw still wants to draw.
 * Children come immediately before their frame (Excalidraw's invariant).
 * When every node has a fractional index, that order wins.
 *
 * Pure tracked read — do not stamp costume clocks here.
 */
export function snapshot(scene: Scene): X.ExcalidrawElement[] {
  return orderForView(scene).map((node) => node.toJSON());
}

function orderForView(scene: Scene): ExcalidrawAnyElement[] {
  const nodes = walk(scene.children).toArray();
  if (nodes.length > 0 && nodes.every((n) => n.index != null)) {
    return nodes.sort((a, b) => {
      if (a.index === b.index) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return a.index! < b.index! ? -1 : 1;
    });
  }
  const out: ExcalidrawAnyElement[] = [];
  const emit = (node: ExcalidrawAnyElement) => {
    if (isFrameLike(node)) {
      for (const child of node.children) emit(child);
    }
    out.push(node);
  };
  for (const node of scene.children) emit(node);
  return out;
}

export type EditorVersionState = Map<string, { json: string; version: number }>;

/**
 * Stamp Excalidraw costume `version` / `versionNonce`. Call from an effect
 * after MobX has decided the view changed — never from a derivation.
 */
export function stampEditorVersions(
  elements: X.ExcalidrawElement[],
  state: EditorVersionState,
): X.ExcalidrawElement[] {
  const seen = new Set<string>();
  const out = elements.map((el) => {
    seen.add(el.id);
    const { version: _v, versionNonce: _n, updated: _u, ...rest } = el;
    const json = JSON.stringify(rest);
    const prev = state.get(el.id);
    if (prev && prev.json === json) {
      return { ...el, version: prev.version, versionNonce: prev.version, updated: prev.version };
    }
    const version = (prev?.version ?? 0) + 1;
    state.set(el.id, { json, version });
    return { ...el, version, versionNonce: version, updated: version };
  });
  for (const id of state.keys()) {
    if (!seen.has(id)) state.delete(id);
  }
  return out;
}
