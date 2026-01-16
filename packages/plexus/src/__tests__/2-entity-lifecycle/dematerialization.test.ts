/**
 * Tests for ephemeral model behavior with undo/redo.
 *
 * Ephemeral models (created but not yet synced) interact with undo/redo in ways
 * that can produce undefined behavior. These tests document expected behavior:
 *
 * 1. Simple cases work - ephemeral models can be undone/redone safely
 * 2. Cross-reference cases where a synced model has a dematerialized parent
 *    are undefined behavior and may throw
 */

import { beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing
class Item extends PlexusModel {
  @syncing
  accessor name: string = "";
}

@syncing
class Container extends PlexusModel {
  @syncing
  accessor name: string = "";

  @syncing.child
  accessor item: Item | null = null;

  @syncing.child.list
  accessor items: Item[] = [];

  @syncing
  accessor ref: Item | null = null;
}

@syncing
class Root extends PlexusModel {
  @syncing.child.list
  accessor containers: Container[] = [];

  @syncing.child.list
  accessor globals: Item[] = [];
}

describe("Ephemeral model undo/redo behavior", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<Root>;
  let root: Root;

  beforeEach(() => {
    const result = initTestPlexus(new Root({ containers: [], globals: [] }));
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  describe("Simple ephemeral undo cases", () => {
    it("should handle add ephemeral → undo instantly", () => {
      const item = new Item({ name: "ephemeral" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      expect(root.globals).toContain(item);
      expect(item.name).toBe("ephemeral");

      plexus.undo();

      expect(root.globals).not.toContain(item);
      // Dematerialized model throws on access
      expect(item.__internals__.isDematerialized).toBe(true);
      expect(() => item.name).toThrow("dematerialized");
    });

    it("should handle add ephemeral → undo → redo", () => {
      const item = new Item({ name: "ephemeral" });

      plexus.transact(() => {
        root.globals.push(item);
        item.name = "modified";
      });

      expect(root.globals).toContain(item);
      expect(item.name).toBe("modified");

      plexus.undo();

      expect(root.globals).not.toContain(item);
      expect(item.__internals__.isDematerialized).toBe(true);

      plexus.redo();

      expect(root.globals).toContain(item);
      expect(item.__internals__.isDematerialized).toBeFalsy();
      expect(item.name).toBe("modified");
    });

    it("should handle add ephemeral → undo → add again", () => {
      const item = new Item({ name: "first" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      plexus.undo();

      expect(root.globals).not.toContain(item);
      expect(item.__internals__.isDematerialized).toBe(true);

      // Add the same item again (re-materialize)
      plexus.transact(() => {
        root.globals.push(item);
      });

      expect(root.globals).toContain(item);
      expect(item.__internals__.isDematerialized).toBeFalsy();
      expect(item.name).toBe("first");
    });

    it("should handle add ephemeral → undo → add different → redo", () => {
      const item1 = new Item({ name: "first" });
      const item2 = new Item({ name: "second" });

      plexus.transact(() => {
        root.globals.push(item1);
      });

      plexus.undo();

      plexus.transact(() => {
        root.globals.push(item2);
      });

      expect(root.globals).toContain(item2);
      expect(root.globals).not.toContain(item1);

      // Redo should be cleared by the new operation
      // This is standard undo/redo semantics
      plexus.redo();

      // Should not have changed
      expect(root.globals).toContain(item2);
      expect(root.globals).not.toContain(item1);
    });
  });

  describe("Multiple undo/redo cycles", () => {
    it("should handle all changes in single undo frame (captureTimeout merges)", () => {
      // Y.UndoManager has captureTimeout: 500, so rapid transactions merge into one frame
      const item = new Item({ name: "start" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      plexus.transact(() => {
        item.name = "middle";
      });

      plexus.transact(() => {
        item.name = "end";
      });

      expect(item.name).toBe("end");

      // All three transactions merged into one undo frame
      // Single undo reverts everything - item is dematerialized
      plexus.undo();
      expect(root.globals).not.toContain(item);
      expect(item.__internals__.isDematerialized).toBe(true);

      // Single redo restores everything
      plexus.redo();
      expect(root.globals).toContain(item);
      expect(item.__internals__.isDematerialized).toBeFalsy();
      expect(item.name).toBe("end");
    });
  });

  describe("Parent-child undo with nested structures", () => {
    it("should dematerialize container and nested child on undo", () => {
      const container = new Container({ name: "container", item: null, items: [], ref: null });
      const item = new Item({ name: "item" });

      plexus.transact(() => {
        root.containers.push(container);
        container.item = item;
      });

      expect(root.containers).toContain(container);
      expect(container.item).toBe(item);
      expect(item.parent).toBe(container);

      plexus.undo();

      expect(root.containers).not.toContain(container);
      // Both container and item are dematerialized - access throws
      expect(container.__internals__.isDematerialized).toBe(true);
      expect(item.__internals__.isDematerialized).toBe(true);
      expect(() => container.name).toThrow("dematerialized");
      expect(() => item.name).toThrow("dematerialized");
    });

    it("should dematerialize all in merged undo frame", () => {
      // Since captureTimeout merges rapid transactions, setup + reparent are one frame
      const container1 = new Container({ name: "c1", item: null, items: [], ref: null });
      const container2 = new Container({ name: "c2", item: null, items: [], ref: null });
      const item = new Item({ name: "item" });

      // Setup both containers
      plexus.transact(() => {
        root.containers.push(container1, container2);
        container1.item = item;
      });

      expect(container1.item).toBe(item);
      expect(container2.item).toBe(null);

      // Reparent item (merges into same undo frame due to captureTimeout)
      plexus.transact(() => {
        container2.item = item;
      });

      expect(container1.item).toBe(null);
      expect(container2.item).toBe(item);

      // Undo reverts both operations (merged frame)
      plexus.undo();

      // All dematerialized
      expect(root.containers).not.toContain(container1);
      expect(root.containers).not.toContain(container2);
      expect(container1.__internals__.isDematerialized).toBe(true);
      expect(container2.__internals__.isDematerialized).toBe(true);
      expect(item.__internals__.isDematerialized).toBe(true);
    });
  });

  describe("Reference vs child field undo", () => {
    it("should handle undo with reference fields (same undo frame)", () => {
      // Since captureTimeout merges, both transactions form one undo frame
      const item = new Item({ name: "shared" });
      const container = new Container({ name: "container", item: null, items: [], ref: null });

      // First add item to globals (becomes synced)
      plexus.transact(() => {
        root.globals.push(item);
      });

      // Then add container and reference the item (merges into same frame)
      plexus.transact(() => {
        root.containers.push(container);
        container.ref = item; // ref field, not child
      });

      expect(container.ref).toBe(item);
      expect(item.parent).toBe(root); // Still parented to root via globals

      plexus.undo();

      // Both transactions undone together (merged frame)
      expect(root.containers).not.toContain(container);
      expect(root.globals).not.toContain(item);
    });

    it("should demonstrate reference field semantics in single transaction", () => {
      // Setup: item is already synced in a previous frame (we'll use setup)
      const item = new Item({ name: "shared" });

      // Add item in beforeEach-style setup
      plexus.transact(() => {
        root.globals.push(item);
      });

      // Now in a SEPARATE action, add container with reference
      // (but still same undo frame due to captureTimeout)
      const container = new Container({ name: "container", item: null, items: [], ref: null });

      plexus.transact(() => {
        root.containers.push(container);
        container.ref = item; // Reference, not ownership
      });

      // Item is parented to root (via globals child field)
      // Container.ref is just a reference, doesn't change parent
      expect(item.parent).toBe(root);
      expect(container.ref).toBe(item);

      // Test passes - demonstrates reference semantics work
      expect(root.globals).toContain(item);
      expect(root.containers).toContain(container);
    });
  });

  describe("Dematerialized model access behavior", () => {
    it("should throw on any field access to dematerialized model", () => {
      const item = new Item({ name: "original" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      plexus.undo();

      // Both read and write should throw - use fresh models via root path
      expect(() => item.name).toThrow("dematerialized by undo");
      expect(() => {
        item.name = "new value";
      }).toThrow("dematerialized by undo");
    });

    it("should throw when accessing child list on dematerialized model", () => {
      const container = new Container({
        name: "container",
        item: null,
        items: [],
        ref: null,
      });

      plexus.transact(() => {
        root.containers.push(container);
        container.items.push(new Item({ name: "item" }));
      });

      plexus.undo();

      expect(() => container.items).toThrow("dematerialized by undo");
    });

    it("should throw when accessing child val on dematerialized model", () => {
      const container = new Container({
        name: "container",
        item: null,
        items: [],
        ref: null,
      });

      plexus.transact(() => {
        root.containers.push(container);
        container.item = new Item({ name: "child" });
      });

      plexus.undo();

      expect(() => container.item).toThrow("dematerialized by undo");
    });

    it("should allow checking isDematerialized without throwing", () => {
      const item = new Item({ name: "test" });

      plexus.transact(() => {
        root.globals.push(item);
      });

      expect(item.__internals__.isDematerialized).toBeFalsy();

      plexus.undo();

      // Can check dematerialization status without throwing
      expect(item.__internals__.isDematerialized).toBe(true);
    });
  });

  describe("Edge case: model added to multiple locations", () => {
    it("should handle item moved between containers (same undo frame)", () => {
      // All rapid transactions merge into one undo frame
      const container1 = new Container({ name: "c1", item: null, items: [], ref: null });
      const container2 = new Container({ name: "c2", item: null, items: [], ref: null });

      plexus.transact(() => {
        root.containers.push(container1, container2);
      });

      const item = new Item({ name: "item" });

      // Add to c1
      plexus.transact(() => {
        container1.items.push(item);
      });

      // Move to c2 (merges into same undo frame)
      plexus.transact(() => {
        container2.items.push(item); // Auto-removes from c1
      });

      expect(container1.items).not.toContain(item);
      expect(container2.items).toContain(item);

      // Single undo reverts everything (merged frame)
      plexus.undo();

      // All three transactions undone: containers removed, item dematerialized
      expect(root.containers).not.toContain(container1);
      expect(root.containers).not.toContain(container2);
    });

    it("should correctly track parent after move within same transaction", () => {
      const container1 = new Container({ name: "c1", item: null, items: [], ref: null });
      const container2 = new Container({ name: "c2", item: null, items: [], ref: null });
      const item = new Item({ name: "item" });

      // All in one transaction to be explicit
      plexus.transact(() => {
        root.containers.push(container1, container2);
        container1.items.push(item);
        container2.items.push(item); // Moves from c1 to c2
      });

      // After transaction, item is only in c2
      expect(container1.items).not.toContain(item);
      expect(container2.items).toContain(item);
      expect(item.parent).toBe(container2);

      // Undo reverts entire transaction
      plexus.undo();

      expect(root.containers).not.toContain(container1);
      expect(root.containers).not.toContain(container2);
    });
  });
});
