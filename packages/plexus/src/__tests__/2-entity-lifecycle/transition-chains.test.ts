/**
 * Lifecycle transition chain tests
 *
 * Tests for complex state transitions:
 * - Ephemeral → Materialized transitions
 * - Child adoption/orphanization chains
 * - Entity movement between parents
 * - Deep hierarchy transitions
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing
class Node extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor child: Node | null = null;
  @syncing.child.list accessor children: Node[] = [];
}

@syncing
class Root extends PlexusModel<null> {
  @syncing.child accessor primary: Node | null = null;
  @syncing.child accessor secondary: Node | null = null;
  @syncing.child.list accessor nodes: Node[] = [];
  @syncing.child.record accessor namedNodes: Record<string, Node> = {};
}

describe("Lifecycle Transition Chains", () => {
  describe("ephemeral to materialized", () => {
    it("materializes entire subtree when assigned to root", () => {
      const { root } = initTestPlexus(new Root());

      // Create ephemeral subtree
      const grandchild = new Node({ name: "grandchild" });
      const child = new Node({ name: "child", child: grandchild });
      const parent = new Node({ name: "parent", child });

      // Assign to root - should materialize entire subtree
      root.primary = parent;

      // All nodes should be materialized (have uuid)
      expect(root.primary!.uuid).toBeDefined();
      expect(root.primary!.child!.uuid).toBeDefined();
      expect(root.primary!.child!.child!.uuid).toBeDefined();
    });

    it("materializes array of ephemeral children", () => {
      const { root } = initTestPlexus(new Root());

      // Create ephemeral nodes
      const nodes = [new Node({ name: "a" }), new Node({ name: "b" }), new Node({ name: "c" })];

      // Assign as array
      (root.nodes as any).assign(nodes);

      // All should be materialized
      expect(root.nodes.length).toBe(3);
      root.nodes.forEach((node, i) => {
        expect(node.uuid).toBeDefined();
        expect(node.name).toBe(["a", "b", "c"][i]);
      });
    });

    it("materializes record of ephemeral children", () => {
      const { root } = initTestPlexus(new Root());

      root.namedNodes["x"] = new Node({ name: "X" });
      root.namedNodes["y"] = new Node({ name: "Y" });

      expect(root.namedNodes["x"].uuid).toBeDefined();
      expect(root.namedNodes["y"].uuid).toBeDefined();
    });
  });

  describe("child movement between parents", () => {
    it("moves child from one field to another", () => {
      const { root } = initTestPlexus(new Root());

      const node = new Node({ name: "movable" });
      root.primary = node;

      const uuid = root.primary!.uuid;

      // Move to secondary
      root.secondary = root.primary;
      root.primary = null;

      expect(root.primary).toBeNull();
      expect(root.secondary!.name).toBe("movable");
      // Same entity, same uuid
      expect(root.secondary!.uuid).toBe(uuid);
    });

    it("moves child from field to array", () => {
      const { root } = initTestPlexus(new Root());

      const node = new Node({ name: "to-array" });
      root.primary = node;

      const ref = root.primary!;
      root.nodes.push(ref);
      root.primary = null;

      expect(root.primary).toBeNull();
      expect(root.nodes.length).toBe(1);
      expect(root.nodes[0].name).toBe("to-array");
    });

    it("moves child from array to field", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "from-array" }));

      const ref = root.nodes[0];
      root.primary = ref;
      root.nodes.pop();

      expect(root.nodes.length).toBe(0);
      expect(root.primary!.name).toBe("from-array");
    });

    it("moves child from array to record", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "to-record" }));

      const ref = root.nodes[0];
      root.namedNodes["moved"] = ref;
      root.nodes.pop();

      expect(root.nodes.length).toBe(0);
      expect(root.namedNodes["moved"].name).toBe("to-record");
    });
  });

  describe("deep hierarchy transitions", () => {
    it("handles moving deep nested child to root level", () => {
      const { root } = initTestPlexus(new Root());

      // Create deep hierarchy: root → primary → child → child
      root.primary = new Node({
        name: "level1",
        child: new Node({
          name: "level2",
          child: new Node({ name: "level3" }),
        }),
      });

      // Get reference to deepest node
      const deep = root.primary!.child!.child!;
      expect(deep.name).toBe("level3");

      // Move to root level
      root.secondary = deep;

      // Original path should be cleared
      expect(root.primary!.child!.child).toBeNull();

      // Node should be at new location
      expect(root.secondary!.name).toBe("level3");
    });

    it("handles swapping children at different levels", () => {
      const { root } = initTestPlexus(new Root());

      root.primary = new Node({
        name: "parent",
        child: new Node({ name: "child" }),
      });

      // Create another child
      root.secondary = new Node({ name: "other" });

      // Swap: move primary's child to secondary, move secondary to primary's child
      const childRef = root.primary!.child!;
      const secondaryRef = root.secondary!;

      // Clear original locations first
      root.primary!.child = null;
      root.secondary = null;

      // Set to new locations
      root.secondary = childRef;
      root.primary!.child = secondaryRef;

      expect(root.primary!.child!.name).toBe("other");
      expect(root.secondary!.name).toBe("child");
    });
  });

  describe("array reordering as transitions", () => {
    it("handles sorting children in array", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "c" }));
      root.nodes.push(new Node({ name: "a" }));
      root.nodes.push(new Node({ name: "b" }));

      // Sort by name
      root.nodes.sort((a, b) => a.name.localeCompare(b.name));

      expect(root.nodes[0].name).toBe("a");
      expect(root.nodes[1].name).toBe("b");
      expect(root.nodes[2].name).toBe("c");
    });

    it("handles reversing children in array", () => {
      const { root } = initTestPlexus(new Root());

      root.nodes.push(new Node({ name: "first" }));
      root.nodes.push(new Node({ name: "second" }));
      root.nodes.push(new Node({ name: "third" }));

      const uuids = root.nodes.map((n) => n.uuid);

      root.nodes.reverse();

      expect(root.nodes[0].name).toBe("third");
      expect(root.nodes[1].name).toBe("second");
      expect(root.nodes[2].name).toBe("first");

      // Same entities, just reordered
      expect(root.nodes.map((n) => n.uuid)).toEqual(uuids.reverse());
    });
  });

  describe("cross-document lifecycle", () => {
    it("entity survives document sync and maintains identity", () => {
      const { root: root1, plexus: plexus1 } = initTestPlexus(new Root());

      root1.primary = new Node({ name: "synced" });
      const originalUuid = root1.primary!.uuid;

      // Create second document and sync
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));

      const { root: root2 } = connectTestPlexus<Root>(doc2);

      // Same entity should exist in both docs
      expect(root2.primary!.uuid).toBe(originalUuid);
      expect(root2.primary!.name).toBe("synced");

      doc2.destroy();
    });

    it("modifications sync bidirectionally", () => {
      const { root: root1, plexus: plexus1 } = initTestPlexus(new Root());

      root1.primary = new Node({ name: "original" });

      // Create and sync doc2
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));
      const { root: root2 } = connectTestPlexus<Root>(doc2);

      // Modify in doc1
      root1.primary!.name = "modified-in-doc1";

      // Sync to doc2
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(plexus1.doc));
      expect(root2.primary!.name).toBe("modified-in-doc1");

      // Modify in doc2
      root2.primary!.name = "modified-in-doc2";

      // Sync back to doc1
      Y.applyUpdate(plexus1.doc, Y.encodeStateAsUpdate(doc2));
      expect(root1.primary!.name).toBe("modified-in-doc2");

      doc2.destroy();
    });
  });

  describe("orphanization chains", () => {
    it("orphaned subtree can be re-adopted", () => {
      const { root } = initTestPlexus(new Root());

      // Create subtree
      root.primary = new Node({
        name: "parent",
        child: new Node({ name: "child" }),
      });

      // Get reference and orphan
      const subtree = root.primary!;
      root.primary = null;

      // Re-adopt
      root.secondary = subtree;

      expect(root.secondary!.name).toBe("parent");
      expect(root.secondary!.child!.name).toBe("child");
    });

    it("orphaned child remains modifiable", () => {
      const { root } = initTestPlexus(new Root());

      root.primary = new Node({ name: "will-be-orphaned" });

      const orphan = root.primary!;
      root.primary = null;

      // Modify orphaned node
      orphan.name = "orphan-modified";

      // Re-adopt and verify modification persisted
      root.primary = orphan;
      expect(root.primary!.name).toBe("orphan-modified");
    });
  });
});
