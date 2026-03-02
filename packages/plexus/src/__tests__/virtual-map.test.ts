/**
 * Tests for @syncing.virtual() decorator — VirtualMap public API.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../decorators.js";
import { PlexusModel } from "../PlexusModel.js";
import type { VirtualMap } from "../proxy-runtime-types.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

// ── Test models ──

@syncing
class VItem extends PlexusModel {
  static override readonly modelName = "VItem";
  @syncing accessor label!: string;
}

@syncing
class VHost extends PlexusModel {
  @syncing accessor name!: string;
  @syncing.virtual((key: string) => new VItem({ label: `auto-${key}` }))
  accessor items!: VirtualMap<string, VItem>;
}

// Subclass to test inheritance
@syncing
class VHostChild extends VHost {
  static override readonly modelName = "VHostChild";
}

// Model with numeric keys
@syncing
class VNumHost extends PlexusModel {
  static override readonly modelName = "VNumHost";
  @syncing.virtual((key: number) => new VItem({ label: `num-${key}` }))
  accessor slots!: VirtualMap<number, VItem>;
}

// ── Tests ──

describe("VirtualMap (@syncing.virtual)", () => {
  // ── Auto-materialization ──

  describe("auto-materialization", () => {
    it(".get(key) creates child on first access", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      const item = root.items.get("a");
      expect(item).toBeInstanceOf(PlexusModel);
      expect(item.label).toBe("auto-a");
    });

    it("second .get(key) returns same instance", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      const first = root.items.get("a");
      const second = root.items.get("a");
      expect(first).toBe(second);
    });

    it("different keys produce different children", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      const a = root.items.get("a");
      const b = root.items.get("b");
      expect(a).not.toBe(b);
      expect(a.label).toBe("auto-a");
      expect(b.label).toBe("auto-b");
    });

    it("numeric keys work", () => {
      const { root } = initTestPlexus(new VNumHost({}));

      const item = root.slots.get(42);
      expect(item.label).toBe("num-42");
    });
  });

  // ── Mutation blocking ──

  describe("mutation blocking", () => {
    it(".set() throws", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      expect(() => {
        (root.items as any).set("x", new VItem({ label: "manual" }));
      }).toThrow("VirtualMap");
    });

    it(".delete() throws", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));
      root.items.get("a"); // materialize first

      expect(() => {
        (root.items as any).delete("a");
      }).toThrow("VirtualMap");
    });

    it(".clear() throws", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));
      root.items.get("a"); // materialize first

      expect(() => {
        (root.items as any).clear();
      }).toThrow("VirtualMap");
    });

    it(".assign() throws", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      expect(() => {
        (root.items as any).assign(new Map([["x", new VItem({ label: "x" })]]));
      }).toThrow("VirtualMap");
    });
  });

  // ── Read operations ──

  describe("read operations", () => {
    it(".has() returns true after materialization", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      expect(root.items.has("a")).toBe(false);
      root.items.get("a");
      expect(root.items.has("a")).toBe(true);
    });

    it(".size reflects materialized entries", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      expect(root.items.size).toBe(0);
      root.items.get("a");
      expect(root.items.size).toBe(1);
      root.items.get("b");
      expect(root.items.size).toBe(2);
    });

    it("iteration works over materialized entries", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      root.items.get("x");
      root.items.get("y");

      const keys = [...root.items.keys()];
      expect(keys).toHaveLength(2);
      expect(keys).toContain("x");
      expect(keys).toContain("y");
    });

    it("forEach works", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      root.items.get("p");
      root.items.get("q");

      const labels: string[] = [];
      root.items.forEach((v) => labels.push(v.label));
      expect(labels).toContain("auto-p");
      expect(labels).toContain("auto-q");
    });
  });

  // ── Reparenting guard ──

  describe("reparenting guard", () => {
    it("moving virtual child to different parent throws", () => {
      // Both models in same doc so doc-mismatch doesn't fire first
      @syncing
      class VHostWithReceiver extends PlexusModel {
        static override readonly modelName = "VHostWithReceiver";
        @syncing accessor name!: string;
        @syncing.virtual((key: string) => new VItem({ label: `auto-${key}` }))
        accessor items!: VirtualMap<string, VItem>;
        @syncing.child accessor held: VItem | null = null;
      }

      const { root } = initTestPlexus(new VHostWithReceiver({ name: "host" }));
      const child = root.items.get("a");

      expect(() => {
        root.held = child;
      }).toThrow("cannot be reparented");
    });
  });

  // ── Detach guard ──

  describe("detach guard", () => {
    it(".detach() on virtual child throws", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));
      const child = root.items.get("a");

      expect(() => {
        child.detach();
      }).toThrow("cannot be detached");
    });
  });

  // ── Clone ──

  describe("clone", () => {
    it("cloning model with virtual map produces empty virtual map", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));
      root.items.get("a");
      root.items.get("b");
      expect(root.items.size).toBe(2);

      const cloned = root.clone();
      // Virtual maps start empty on clones — children auto-materialize on access
      expect(cloned.items.size).toBe(0);
      expect(cloned.name).toBe("host");
    });

    it("cloned virtual map still auto-materializes", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));
      root.items.get("a");

      const cloned = root.clone();
      // Need to connect to doc for auto-materialization
      const { root: clonedRoot } = initTestPlexus(cloned);
      const item = clonedRoot.items.get("x");
      expect(item.label).toBe("auto-x");
    });
  });

  // ── Inheritance ──

  describe("inheritance", () => {
    it("subclass inherits parent's virtual factory", () => {
      const { root } = initTestPlexus(new VHostChild({ name: "child-host" }));

      const item = root.items.get("inherited");
      expect(item).toBeInstanceOf(PlexusModel);
      expect(item.label).toBe("auto-inherited");
    });
  });

  // ── CRDT convergence ──

  describe("CRDT convergence", () => {
    it("two peers auto-materialize same key → identical UUIDs, sync is no-op", () => {
      const docId = "virtual-map-convergence";

      // Peer 1
      const { root: root1, doc: doc1 } = initTestPlexus(new VHost({ name: "host" }), {}, docId);

      // Peer 2: sync parent state
      const doc2 = new Y.Doc({ guid: docId });
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
      const { root: root2 } = connectTestPlexus<VHost>(doc2);

      // Both peers auto-materialize same key independently
      const item1 = root1.items.get("shared");
      const item2 = root2.items.get("shared");

      expect(item1.uuid).toBe(item2.uuid);
      expect(item1.label).toBe(item2.label);

      // Bidirectional sync
      const sv1 = Y.encodeStateVector(doc1);
      const sv2 = Y.encodeStateVector(doc2);
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, sv2));
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, sv1));

      // After sync: both have exactly 1 item
      expect(root1.items.size).toBe(1);
      expect(root2.items.size).toBe(1);
    });
  });

  // ── Undo invisibility ──

  describe("undo invisibility", () => {
    it("auto-materialized children survive undo", () => {
      const { root, plexus } = initTestPlexus(new VHost({ name: "host" }));

      root.items.get("survivor");
      expect(root.items.has("survivor")).toBe(true);

      plexus.undo();
      expect(root.items.has("survivor")).toBe(true);
      expect(root.items.get("survivor").label).toBe("auto-survivor");
    });
  });

  // ── Parent chain ──

  describe("parent chain", () => {
    it("auto-materialized child has correct parent", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      const item = root.items.get("child");
      expect(item.parent).toBe(root);
      expect(item.parentField).toBe("items");
    });

    it("child has d-prefix UUID", () => {
      const { root } = initTestPlexus(new VHost({ name: "host" }));

      const item = root.items.get("d-check");
      expect(item.uuid.startsWith("d")).toBe(true);
    });
  });
});
