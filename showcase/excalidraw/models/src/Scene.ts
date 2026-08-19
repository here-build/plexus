import type * as X from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { PlexusModel, syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";
import { applyFiles } from "./files.js";
import { ExcalidrawArrowElement } from "./ExcalidrawArrowElement.js";
import { ExcalidrawDiamondElement } from "./ExcalidrawDiamondElement.js";
import { ExcalidrawEmbeddableElement } from "./ExcalidrawEmbeddableElement.js";
import { ExcalidrawEllipseElement } from "./ExcalidrawEllipseElement.js";
import type { ExcalidrawFile } from "./ExcalidrawFile.js";
import { ExcalidrawFrameElement } from "./ExcalidrawFrameElement.js";
import { ExcalidrawFreeDrawElement } from "./ExcalidrawFreeDrawElement.js";
import { walk } from "./walk.js";
import { ExcalidrawIframeElement } from "./ExcalidrawIframeElement.js";
import { ExcalidrawImageElement } from "./ExcalidrawImageElement.js";
import { ExcalidrawLineElement } from "./ExcalidrawLineElement.js";
import { ExcalidrawMagicFrameElement } from "./ExcalidrawMagicFrameElement.js";
import { ExcalidrawRectangleElement } from "./ExcalidrawRectangleElement.js";
import { ExcalidrawTextElement } from "./ExcalidrawTextElement.js";
import type { ExcalidrawAnyElement } from "./types.js";

/**
 * Their Scene. `elements` is the editor-id → model registry — a map, not
 * ownership. Putting a node in the map materializes it; it still does not
 * belong to the tree until it is parented (`children` here, or a frame's
 * `children`). `isDetached` is that gap: registered vs used.
 */
@syncing("Scene")
export class Scene extends PlexusModel<null> {
  static {
    // cyclic dependency break
    ExcalidrawElement.Scene = this;
  }

  @syncing.map accessor elements: Map<string, ExcalidrawAnyElement> = new Map();
  @syncing.map accessor files: Map<string, ExcalidrawFile> = new Map();
  @syncing.child.list accessor children: ExcalidrawAnyElement[] = [];

  get id() {
    return this.uuid;
  }

  /** Root of the frameId walk. An element's frameId is its parent's. */
  get frameId() {
    return this.id;
  }

  getElement(id: string): ExcalidrawAnyElement | null {
    return this.elements.get(id) ?? null;
  }

  /** Store the editor id on the node and in the registry. */
  register(node: ExcalidrawAnyElement, id: string): void {
    this.elements.set(id, node);
  }

  /**
   * One constructor per document `type`. `selection` is not a document type.
   * The cases below are the live imports of every model class — importing
   * Scene is what registers them.
   */
  createElement<T extends ExcalidrawAnyElement>(type: T["type"]): T {
    switch (type) {
      case "text":
        return new ExcalidrawTextElement() as T;
      case "frame":
        return new ExcalidrawFrameElement() as T;
      case "magicframe":
        return new ExcalidrawMagicFrameElement() as T;
      case "arrow":
        return new ExcalidrawArrowElement() as T;
      case "line":
        return new ExcalidrawLineElement() as T;
      case "diamond":
        return new ExcalidrawDiamondElement() as T;
      case "ellipse":
        return new ExcalidrawEllipseElement() as T;
      case "freedraw":
        return new ExcalidrawFreeDrawElement() as T;
      case "image":
        return new ExcalidrawImageElement() as T;
      case "embeddable":
        return new ExcalidrawEmbeddableElement() as T;
      case "iframe":
        return new ExcalidrawIframeElement() as T;
      case "rectangle":
        return new ExcalidrawRectangleElement() as T;
      default:
        throw new Error(`unknown element type: ${String(type)}`);
    }
  }

  /**
   * Editor id → `elements` (registry, not ownership). A miss spawns
   * and registers; the node appears when `frameId` parents it onto the tree.
   *
   * The bag is the write. Spawn, park on `children` so unframed nodes stay
   * on the tree, then `Object.assign` — structs `.assign`, costume setters
   * land on the graph. Bindings resolve on a second pass after every id is
   * registered.
   */
  @syncing.action
  ingest(elements: readonly X.ExcalidrawElement[]): void {
    if (elements.length === 0) {
      for (const node of walk(this.children).toArray()) node.isDeleted = true;
      return;
    }
    const live = new Set<ExcalidrawAnyElement>();

    for (const el of elements) {
      if (el.type === "selection") continue;
      if (el.isDeleted) {
        const node = this.elements.get(el.id);
        if (node) node.isDeleted = true;
        continue;
      }
      let node = this.elements.get(el.id);
      if (node && node.type !== el.type) {
        node.isDeleted = true;
        this.elements.delete(el.id);
        node = undefined;
      }
      if (!node) {
        node = this.createElement(el.type);
        this.register(node, el.id);
      }
      live.add(node);
      if (!node.parent) this.children.push(node);
    }

    for (const el of elements) {
      if (el.isDeleted || el.type === "selection") continue;
      const node = this.elements.get(el.id);
      if (!node) continue;
      const { type: _type, isDeleted: _gone, ...bag } = el;
      Object.assign(node, bag);
    }

    for (const node of walk(this.children).toArray()) {
      if (!live.has(node)) node.isDeleted = true;
    }
  }

  @syncing.action
  ingestFiles(files: BinaryFiles): void {
    applyFiles(this, files);
  }

  @syncing.action
  applyEditor(elements: readonly X.ExcalidrawElement[], files: BinaryFiles): void {
    this.ingestFiles(files);
    this.ingest(elements);
  }

  getNonDeletedElements(): ExcalidrawAnyElement[] {
    return walk(this.children)
      .filter((el) => !el.isDeleted)
      .toArray();
  }
}
