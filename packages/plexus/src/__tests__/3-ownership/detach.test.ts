/**
 * Detach Method Tests
 *
 * Tests the explicit detach() method for disconnecting entities from their parents.
 * The detach() method is useful for operations like node swapping that need to
 * temporarily disconnect entities.
 */

import { describe, expect, it } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing
class Node extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor childVal: Node | null = null;
  @syncing.child.list accessor childList: Node[] = [];
  @syncing.child.record accessor childRecord: Record<string, Node> = {};
  @syncing.child.set accessor childSet: Set<Node> = new Set();
}

@syncing
class Root extends PlexusModel<null> {
  @syncing.child accessor primary: Node | null = null;
}

describe("Detach Method", () => {
  describe("return value", () => {
    it("returns true when entity was attached", () => {
      const { root } = initTestPlexus(new Root());
      const node = new Node({ name: "A" });

      root.primary = node;
      expect(node.parent).toBe(root);

      const wasAttached = node.detach();

      expect(wasAttached).toBe(true);
      expect(node.parent).toBeNull();
    });

    it("returns false when entity was already detached", () => {
      const { root } = initTestPlexus(new Root());
      const node = new Node({ name: "A" });

      // Node created but never attached
      expect(node.parent).toBeNull();

      const wasAttached = node.detach();

      expect(wasAttached).toBe(false);
      expect(node.parent).toBeNull();
    });

    it("returns false on second detach call", () => {
      const { root } = initTestPlexus(new Root());
      const node = new Node({ name: "A" });

      root.primary = node;

      // First detach
      const firstResult = node.detach();
      expect(firstResult).toBe(true);

      // Second detach on already detached node
      const secondResult = node.detach();
      expect(secondResult).toBe(false);
    });
  });

  describe("parent removal from containers", () => {
    it("removes from child-val field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childVal = child;

      expect(parent.childVal).toBe(child);
      expect(child.parent).toBe(parent);

      child.detach();

      expect(parent.childVal).toBeNull();
      expect(child.parent).toBeNull();
    });

    it("removes from child-list field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childList.push(child);

      expect(parent.childList).toContain(child);
      expect(child.parent).toBe(parent);

      child.detach();

      expect(parent.childList).not.toContain(child);
      expect(parent.childList.length).toBe(0);
      expect(child.parent).toBeNull();
    });

    it("removes from child-record field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childRecord["key"] = child;

      expect(parent.childRecord["key"]).toBe(child);
      expect(child.parent).toBe(parent);

      child.detach();

      expect(parent.childRecord["key"]).toBeUndefined();
      expect(Object.keys(parent.childRecord).length).toBe(0);
      expect(child.parent).toBeNull();
    });

    it("removes from child-set field", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childSet.add(child);

      expect(parent.childSet.has(child)).toBe(true);
      expect(child.parent).toBe(parent);

      child.detach();

      expect(parent.childSet.has(child)).toBe(false);
      expect(parent.childSet.size).toBe(0);
      expect(child.parent).toBeNull();
    });
  });

  describe("use cases", () => {
    it("enables node swapping", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const nodeA = new Node({ name: "A" });
      const nodeB = new Node({ name: "B" });

      root.primary = parent;
      parent.childVal = nodeA;

      // Swap: detach A, set B, verify A is detached
      nodeA.detach();
      parent.childVal = nodeB;

      expect(parent.childVal).toBe(nodeB);
      expect(nodeA.parent).toBeNull();
      expect(nodeB.parent).toBe(parent);

      // Can now attach A elsewhere or to same parent
      parent.childList.push(nodeA);
      expect(nodeA.parent).toBe(parent);
    });

    it("enables safe node relocation", () => {
      const { root } = initTestPlexus(new Root());
      const parentA = new Node({ name: "ParentA" });
      const parentB = new Node({ name: "ParentB" });
      const child = new Node({ name: "Child" });

      root.primary = parentA;
      parentA.childList.push(parentB);
      parentA.childList.push(child);

      // Move child from parentA.childList to parentB.childList
      // Without detach, this would remove from parentA's list automatically
      // But detach makes the operation explicit
      const wasInList = child.detach();
      expect(wasInList).toBe(true);
      expect(parentA.childList).not.toContain(child);

      parentB.childList.push(child);
      expect(child.parent).toBe(parentB);
      expect(parentB.childList).toContain(child);
    });

    it("can be used for conditional detachment", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;

      // Helper function that detaches only if needed
      function ensureDetached(node: Node): boolean {
        return node.detach(); // Returns true only if was attached
      }

      // First call - not attached yet
      expect(ensureDetached(child)).toBe(false);

      // Attach it
      parent.childVal = child;

      // Second call - attached, will detach
      expect(ensureDetached(child)).toBe(true);
      expect(child.parent).toBeNull();

      // Third call - already detached
      expect(ensureDetached(child)).toBe(false);
    });
  });

  describe("deeply nested detachment", () => {
    it("detaches from deeply nested parent", () => {
      const { root } = initTestPlexus(new Root());
      const level1 = new Node({ name: "Level1" });
      const level2 = new Node({ name: "Level2" });
      const level3 = new Node({ name: "Level3" });
      const level4 = new Node({ name: "Level4" });

      root.primary = level1;
      level1.childVal = level2;
      level2.childVal = level3;
      level3.childVal = level4;

      // Verify deep nesting
      expect(level4.parent).toBe(level3);
      expect(level3.parent).toBe(level2);
      expect(level2.parent).toBe(level1);
      expect(level1.parent).toBe(root);

      // Detach from middle
      const wasAttached = level3.detach();

      expect(wasAttached).toBe(true);
      expect(level2.childVal).toBeNull();
      expect(level3.parent).toBeNull();

      // Upper levels unchanged
      expect(level2.parent).toBe(level1);
      expect(level1.parent).toBe(root);

      // Lower level still attached to level3
      expect(level4.parent).toBe(level3);
    });
  });

  describe("multiple children detachment", () => {
    it("detaches multiple children from list", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child1 = new Node({ name: "Child1" });
      const child2 = new Node({ name: "Child2" });
      const child3 = new Node({ name: "Child3" });

      root.primary = parent;
      parent.childList.push(child1, child2, child3);

      expect(parent.childList.length).toBe(3);

      // Detach middle child
      child2.detach();

      expect(parent.childList.length).toBe(2);
      expect(parent.childList).toContain(child1);
      expect(parent.childList).not.toContain(child2);
      expect(parent.childList).toContain(child3);

      // Detach all remaining
      child1.detach();
      child3.detach();

      expect(parent.childList.length).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("can detach and reattach to same parent", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childVal = child;

      child.detach();
      expect(parent.childVal).toBeNull();

      // Reattach to same parent
      parent.childVal = child;
      expect(parent.childVal).toBe(child);
      expect(child.parent).toBe(parent);
    });

    it("can detach and attach to different field of same parent", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new Node({ name: "Parent" });
      const child = new Node({ name: "Child" });

      root.primary = parent;
      parent.childVal = child;

      child.detach();

      // Attach to different field of same parent
      parent.childList.push(child);
      expect(child.parent).toBe(parent);
      expect(parent.childVal).toBeNull();
      expect(parent.childList).toContain(child);
    });

    it("no-op on root entity", () => {
      const { root } = initTestPlexus(new Root());

      // Root has null parent (special case)
      expect(root.parent).toBeNull();

      const wasAttached = root.detach();

      // Returns false because root has no parent
      expect(wasAttached).toBe(false);
      expect(root.parent).toBeNull();
    });
  });
});
