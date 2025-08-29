/**
 * Tests for ownership-aware cloning with child-list, child-set, child-record schema types
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildModelClass } from "../proxy-runtime.js";
import { ModelType } from "../proxy-runtime-types.js";
import * as Y from "yjs";

// Test models for ownership semantics
type ChildComponent = ModelType<
  {
    name: string;
    value: number;
  },
  "ChildComponent"
>;

type ParentWithChildVal = ModelType<
  {
    name: string;
    child: ChildComponent | null; // Will use "child-val"
    reference: ChildComponent | null; // Will use "val" (reference-only)
  },
  "ParentWithChildVal"
>;

type ParentWithChildList = ModelType<
  {
    name: string;
    readonly children: Array<ChildComponent>; // Will use "child-list"
    readonly references: Array<ChildComponent>; // Will use "list" (reference-only)
  },
  "ParentWithChildList"
>;

type ParentWithChildSet = ModelType<
  {
    name: string;
    readonly childSet: Set<ChildComponent>; // Will use "child-set"
    readonly refSet: Set<ChildComponent>; // Will use "set" (reference-only)
  },
  "ParentWithChildSet"
>;

type ParentWithChildRecord = ModelType<
  {
    name: string;
    readonly childMap: Record<string, ChildComponent>; // Will use "child-record"
    readonly refMap: Record<string, ChildComponent>; // Will use "record" (reference-only)
  },
  "ParentWithChildRecord"
>;

const ChildComponent = buildModelClass<ChildComponent>("ChildComponent", {
  name: "val",
  value: "val"
});

const ParentWithChildVal = buildModelClass<ParentWithChildVal>("ParentWithChildVal", {
  name: "val",
  child: "child-val", // Ownership: clone child recursively
  reference: "val" // No ownership: preserve reference
});

const ParentWithChildList = buildModelClass<ParentWithChildList>("ParentWithChildList", {
  name: "val",
  children: "child-list", // Ownership: clone children recursively
  references: "list" // No ownership: preserve references
});

const ParentWithChildSet = buildModelClass<ParentWithChildSet>("ParentWithChildSet", {
  name: "val",
  childSet: "child-set", // Ownership: clone children recursively
  refSet: "set" // No ownership: preserve references
});

const ParentWithChildRecord = buildModelClass<ParentWithChildRecord>("ParentWithChildRecord", {
  name: "val",
  childMap: "child-record", // Ownership: clone children recursively
  refMap: "record" // No ownership: preserve references
});

describe("Ownership-aware cloning", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  describe("child-val ownership", () => {
    it("should deep clone child-val but preserve val references", () => {
      const child = new ChildComponent({ name: "child", value: 1 });

      const parent = new ParentWithChildVal({
        name: "parent",
        child: child, // Will be cloned
        reference: child // Will be preserved as reference
      });

      const cloned = parent.clone();

      // Parent should be different
      expect(cloned.uuid).not.toBe(parent.uuid);
      expect(cloned.name).toBe("parent");

      // child-val: child should be cloned (different UUID)
      expect(cloned.child!.uuid).not.toBe(child.uuid);
      expect(cloned.child!.name).toBe("child"); // But same values
      expect(cloned.child!.value).toBe(1);

      // val: reference should be preserved (same UUID)
      expect(cloned.reference!.uuid).toBe(child.uuid);
      expect(cloned.reference).toBe(child); // Same object reference
    });

    it("should handle null child-val gracefully", () => {
      const parent = new ParentWithChildVal({
        name: "parent",
        child: null,
        reference: null
      });

      const cloned = parent.clone();

      expect(cloned.child).toBe(null);
      expect(cloned.reference).toBe(null);
    });
  });

  describe("child-list ownership", () => {
    it("should deep clone child-list elements but preserve list references", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });

      const parent = new ParentWithChildList({
        name: "parent",
        children: [child1, child2], // Will be cloned
        references: [child1, child2] // Will be preserved as references
      });

      const cloned = parent.clone();

      // Parent should be different
      expect(cloned.uuid).not.toBe(parent.uuid);
      expect(cloned.name).toBe("parent");

      // child-list: children should be cloned (different UUIDs)
      expect(cloned.children).toHaveLength(2);
      expect(cloned.children[0].uuid).not.toBe(child1.uuid);
      expect(cloned.children[1].uuid).not.toBe(child2.uuid);
      expect(cloned.children[0].name).toBe("child1"); // But same values
      expect(cloned.children[1].name).toBe("child2");

      // list: references should be preserved (same UUIDs)
      expect(cloned.references).toHaveLength(2);
      expect(cloned.references[0].uuid).toBe(child1.uuid);
      expect(cloned.references[1].uuid).toBe(child2.uuid);
      expect(cloned.references[0]).toBe(child1); // Same object reference
      expect(cloned.references[1]).toBe(child2);
    });

    it("should handle modifications to cloned children independently", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });

      const parent = new ParentWithChildList({
        name: "parent",
        children: [child1],
        references: [child1]
      });

      const cloned = parent.clone();

      // Modify the cloned child
      cloned.children[0].name = "modified";

      // Original child should be unchanged
      expect(child1.name).toBe("child1");
      expect(parent.children[0].name).toBe("child1");

      // Cloned child should be changed
      expect(cloned.children[0].name).toBe("modified");

      // Reference should still point to original
      expect(cloned.references[0].name).toBe("child1");
      expect(cloned.references[0]).toBe(child1);
    });
  });

  describe("child-set ownership", () => {
    it("should deep clone child-set elements but preserve set references", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });

      const parent = new ParentWithChildSet({
        name: "parent",
        childSet: new Set([child1, child2]), // Will be cloned
        refSet: new Set([child1, child2]) // Will be preserved as references
      });

      const cloned = parent.clone();

      // child-set: children should be cloned
      expect(cloned.childSet.size).toBe(2);
      const clonedChildren = Array.from(cloned.childSet);
      expect(clonedChildren[0].uuid).not.toBe(child1.uuid);
      expect(clonedChildren[1].uuid).not.toBe(child2.uuid);

      // set: references should be preserved
      expect(cloned.refSet.size).toBe(2);
      expect(cloned.refSet.has(child1)).toBe(true);
      expect(cloned.refSet.has(child2)).toBe(true);
    });
  });

  describe("child-record ownership", () => {
    it("should deep clone child-record values but preserve record references", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });

      const parent = new ParentWithChildRecord({
        name: "parent",
        childMap: { first: child1, second: child2 }, // Will be cloned
        refMap: { first: child1, second: child2 } // Will be preserved as references
      });

      const cloned = parent.clone();

      // child-record: values should be cloned
      expect(Object.keys(cloned.childMap)).toEqual(["first", "second"]);
      expect(cloned.childMap.first.uuid).not.toBe(child1.uuid);
      expect(cloned.childMap.second.uuid).not.toBe(child2.uuid);
      expect(cloned.childMap.first.name).toBe("child1"); // Same values
      expect(cloned.childMap.second.name).toBe("child2");

      // record: references should be preserved
      expect(cloned.refMap.first.uuid).toBe(child1.uuid);
      expect(cloned.refMap.second.uuid).toBe(child2.uuid);
      expect(cloned.refMap.first).toBe(child1); // Same object reference
      expect(cloned.refMap.second).toBe(child2);
    });
  });

  describe("circular ownership edge cases", () => {
    // Define circular reference types
    type NodeA = ModelType<{
      name: string;
      nodeB: NodeB | null; // child-val ownership
    }, "NodeA">;

    type NodeB = ModelType<{
      name: string;
      nodeA: NodeA | null; // child-val ownership - creates cycle
    }, "NodeB">;

    const NodeA = buildModelClass<NodeA>("NodeA", {
      name: "val",
      nodeB: "child-val" // Owns NodeB - will clone recursively
    });

    const NodeB = buildModelClass<NodeB>("NodeB", {
      name: "val",
      nodeA: "child-val" // Owns NodeA - creates circular ownership
    });

    it("should handle shared references without cycles", () => {
      // Test the transaction mapping with shared references (no true cycles due to runtime constraints)
      const nodeB = new NodeB({ name: "B", nodeA: null });
      const nodeA = new NodeA({ name: "A", nodeB: nodeB });

      const clonedA = nodeA.clone();

      // Cloned A should be different from original
      expect(clonedA.uuid).not.toBe(nodeA.uuid);
      expect(clonedA.name).toBe("A");

      // Cloned A should have a cloned B
      expect(clonedA.nodeB).not.toBe(null);
      expect(clonedA.nodeB!.uuid).not.toBe(nodeB.uuid);
      expect(clonedA.nodeB!.name).toBe("B");

      // The cloned B should have null nodeA (as constructed)
      expect(clonedA.nodeB!.nodeA).toBe(null);
    });

    it("should handle shared references in collections (single parent constraint)", () => {
      const sharedChild = new ChildComponent({ name: "shared", value: 42 });

      const parent1 = new ParentWithChildList({
        name: "parent1",
        children: [sharedChild], // sharedChild's parent is now parent1
        references: []
      });

      // At this point, sharedChild belongs to parent1
      expect(parent1.children).toHaveLength(1);
      expect(parent1.children[0]).toBe(sharedChild);

      const parent2 = new ParentWithChildList({
        name: "parent2",
        children: [sharedChild, parent1], // sharedChild moves to parent2, removed from parent1
        references: []
      });

      // Parent tracking should have moved sharedChild from parent1 to parent2
      expect(parent1.children).toHaveLength(0); // Empty - sharedChild was removed
      expect(parent2.children).toHaveLength(2);
      expect(parent2.children[0]).toBe(sharedChild);
      expect((parent2.children[1] as any)).toBe(parent1);

      const clonedParent2 = parent2.clone();

      // Should have 2 children: sharedChild and parent1
      expect(clonedParent2.children).toHaveLength(2);

      // First child should be a clone of sharedChild
      expect(clonedParent2.children[0].uuid).not.toBe(sharedChild.uuid);
      expect(clonedParent2.children[0].name).toBe("shared");

      // Second child should be a clone of parent1 (which now has no children)
      expect((clonedParent2.children[1] as any).uuid).not.toBe(parent1.uuid);
      expect((clonedParent2.children[1] as any).name).toBe("parent1");
      expect((clonedParent2.children[1] as any).children).toHaveLength(0); // Empty because sharedChild was moved
    });

    it("should handle deeply nested shared references (single parent constraint)", () => {
      const leafChild = new ChildComponent({ name: "leaf", value: 1 });

      const level2a = new ParentWithChildList({
        name: "level2a",
        children: [leafChild], // leafChild's parent is now level2a
        references: []
      });

      // leafChild belongs to level2a
      expect(level2a.children).toHaveLength(1);
      expect(level2a.children[0]).toBe(leafChild);

      const level2b = new ParentWithChildList({
        name: "level2b",
        children: [leafChild], // leafChild moves from level2a to level2b
        references: []
      });

      // Parent tracking should have moved leafChild from level2a to level2b
      expect(level2a.children).toHaveLength(0); // Empty - leafChild was moved
      expect(level2b.children).toHaveLength(1);
      expect(level2b.children[0]).toBe(leafChild);

      const root = new ParentWithChildList({
        name: "root",
        children: [level2a, level2b], // level2a has no children, level2b has leafChild
        references: []
      });

      const clonedRoot = root.clone();

      // Extract cloned references
      const clonedLevel2a = clonedRoot.children[0] as any;
      const clonedLevel2b = clonedRoot.children[1] as any;

      // Both levels should be cloned
      expect(clonedLevel2a.uuid).not.toBe(level2a.uuid);
      expect(clonedLevel2b.uuid).not.toBe(level2b.uuid);
      expect(clonedLevel2a.name).toBe("level2a");
      expect(clonedLevel2b.name).toBe("level2b");

      // level2a should have no children (leafChild was moved)
      expect(clonedLevel2a.children).toHaveLength(0);

      // level2b should have the cloned leafChild
      expect(clonedLevel2b.children).toHaveLength(1);
      const clonedLeafFromB = clonedLevel2b.children[0];
      expect(clonedLeafFromB.uuid).not.toBe(leafChild.uuid);
      expect(clonedLeafFromB.name).toBe("leaf");
    });

    it("should handle self-referential collections", () => {
      // KNOWN LIMITATION: Self-referential collections (where parent contains itself)
      // currently break the proxy creation mechanism. This is an extremely unusual
      // edge case that would need special handling in the proxy runtime.

      // Test a parent that contains itself in its children list
      const selfRef = new ParentWithChildList({
        name: "selfRef",
        children: [], // Start empty, will add self via push
        references: []
      });

      // Add itself to its own children list (circular reference)
      // Use push since assign() only works on materialized collections
      selfRef.children.push(selfRef as any);

      const cloned = selfRef.clone();

      // Cloned should be different from original
      expect(cloned.uuid).not.toBe(selfRef.uuid);
      expect(cloned.name).toBe("selfRef");

      // The child should be the cloned version pointing to itself
      expect(cloned.children).toHaveLength(1);
      expect(cloned.children[0]).toBe(cloned); // Points to itself
      expect((cloned.children[0] as any).uuid).toBe(cloned.uuid);
    });

    it("should handle complex diamond-shaped shared references (single parent constraint)", () => {
      //     root
      //    /    \
      //  left   right
      //   |      |
      //  empty  shared (moved here)
      //
      const shared = new ChildComponent({ name: "shared", value: 42 });

      const left = new ParentWithChildList({
        name: "left",
        children: [shared], // shared's parent is now left
        references: []
      });

      // shared belongs to left
      expect(left.children).toHaveLength(1);
      expect(left.children[0]).toBe(shared);

      const right = new ParentWithChildList({
        name: "right",
        children: [shared], // shared moves from left to right
        references: []
      });

      // Parent tracking should have moved shared from left to right
      expect(left.children).toHaveLength(0); // Empty - shared was moved
      expect(right.children).toHaveLength(1);
      expect(right.children[0]).toBe(shared);

      const root = new ParentWithChildList({
        name: "root",
        children: [left, right], // left has no children, right has shared
        references: []
      });

      const clonedRoot = root.clone();

      // Extract all cloned references
      const clonedLeft = clonedRoot.children[0] as any;
      const clonedRight = clonedRoot.children[1] as any;

      // Everything should be cloned
      expect(clonedRoot.uuid).not.toBe(root.uuid);
      expect(clonedLeft.uuid).not.toBe(left.uuid);
      expect(clonedRight.uuid).not.toBe(right.uuid);
      
      // Left should have no children (shared was moved)
      expect(clonedLeft.children).toHaveLength(0);
      
      // Right should have the cloned shared
      expect(clonedRight.children).toHaveLength(1);
      const sharedFromRight = clonedRight.children[0];
      expect(sharedFromRight.uuid).not.toBe(shared.uuid);
      expect(sharedFromRight.name).toBe("shared");
      expect(sharedFromRight.value).toBe(42);
    });

    it("should handle mixed ownership and reference semantics", () => {
      const sharedChild = new ChildComponent({ name: "shared", value: 100 });

      const mixedParent = new ParentWithChildList({
        name: "mixed",
        children: [sharedChild], // child-list: will clone
        references: [sharedChild] // list: will preserve reference
      });

      const cloned = mixedParent.clone();

      // The child in children should be cloned
      expect(cloned.children[0].uuid).not.toBe(sharedChild.uuid);
      expect(cloned.children[0].name).toBe("shared");
      expect(cloned.children[0].value).toBe(100);

      // The child in references should be the original
      expect(cloned.references[0]).toBe(sharedChild);
      expect(cloned.references[0].uuid).toBe(sharedChild.uuid);

      // They should be different objects
      expect(cloned.children[0]).not.toBe(cloned.references[0]);
    });

    it("should handle empty collections properly", () => {
      const parent = new ParentWithChildList({
        name: "empty",
        children: [],
        references: []
      });

      const cloned = parent.clone();

      expect(cloned.uuid).not.toBe(parent.uuid);
      expect(cloned.name).toBe("empty");
      expect(cloned.children).toEqual([]);
      expect(cloned.references).toEqual([]);

      // Collections should be different instances
      expect(cloned.children).not.toBe(parent.children);
      expect(cloned.references).not.toBe(parent.references);
    });

    it("should handle null and undefined child values", () => {
      const parentWithNulls = new ParentWithChildVal({
        name: "nulls",
        child: null,
        reference: null
      });

      const cloned = parentWithNulls.clone();

      expect(cloned.uuid).not.toBe(parentWithNulls.uuid);
      expect(cloned.name).toBe("nulls");
      expect(cloned.child).toBe(null);
      expect(cloned.reference).toBe(null);
    });

    it("should handle transaction cleanup properly", () => {
      // Test that the global transaction mapping is cleaned up between operations
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const parent1 = new ParentWithChildList({
        name: "parent1",
        children: [child1],
        references: []
      });

      // First clone
      const cloned1 = parent1.clone();
      expect(cloned1.children[0].uuid).not.toBe(child1.uuid);

      // Second clone should start fresh (not reuse previous mapping)
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const parent2 = new ParentWithChildList({
        name: "parent2",
        children: [child2],
        references: []
      });

      const cloned2 = parent2.clone();
      expect(cloned2.children[0].uuid).not.toBe(child2.uuid);
      expect(cloned2.children[0].uuid).not.toBe(cloned1.children[0].uuid); // Different clones
    });

    it("should handle very large shared reference networks (single parent constraint)", () => {
      // Create a large network where parent tracking moves the child
      const centralChild = new ChildComponent({ name: "central", value: 999 });

      // Create 50 parents that all try to own the same child
      const parents: any[] = [];
      for (let i = 0; i < 50; i++) {
        parents.push(new ParentWithChildList({
          name: `parent${i}`,
          children: [centralChild], // Each assignment moves centralChild to the new parent
          references: []
        }));
      }

      // Parent tracking should have moved centralChild to the last parent
      for (let i = 0; i < 49; i++) {
        expect(parents[i].children).toHaveLength(0); // All previous parents lost the child
      }
      expect(parents[49].children).toHaveLength(1); // Only the last parent has it
      expect(parents[49].children[0]).toBe(centralChild);

      // Create a root that contains all parents
      const megaRoot = new ParentWithChildList({
        name: "megaRoot",
        children: parents,
        references: []
      });

      // This should complete without hanging or crashing
      const clonedMegaRoot = megaRoot.clone();

      // Verify structure is preserved
      expect(clonedMegaRoot.children).toHaveLength(50);

      // All parents should be cloned
      for (let i = 0; i < 50; i++) {
        const clonedParent = clonedMegaRoot.children[i] as any;
        expect(clonedParent.uuid).not.toBe(parents[i].uuid);
        expect(clonedParent.name).toBe(`parent${i}`);
        
        if (i < 49) {
          // First 49 parents should have no children
          expect(clonedParent.children).toHaveLength(0);
        } else {
          // Only the last parent should have the cloned central child
          expect(clonedParent.children).toHaveLength(1);
          const clonedCentral = clonedParent.children[0];
          expect(clonedCentral.uuid).not.toBe(centralChild.uuid);
          expect(clonedCentral.name).toBe("central");
          expect(clonedCentral.value).toBe(999);
        }
      }
    });
  });

  describe("mixed scenarios", () => {
    it("should handle non-cloneable items gracefully", () => {
      const parent = new ParentWithChildList({
        name: "parent",
        children: [
          new ChildComponent({ name: "cloneable", value: 1 }),
          "string value" as any, // Non-cloneable
          42 as any, // Non-cloneable
          null as any // Non-cloneable
        ],
        references: []
      });

      const cloned = parent.clone();

      expect(cloned.children).toHaveLength(4);
      expect(cloned.children[0].uuid).not.toBe(parent.children[0].uuid); // Cloned
      expect(cloned.children[1]).toBe("string value"); // Copied as-is
      expect(cloned.children[2]).toBe(42); // Copied as-is
      expect(cloned.children[3]).toBe(null); // Copied as-is
    });

    it("should handle objects with broken clone methods", () => {
      // With the new implementation, objects need [isProxyEntity] symbol to be cloned
      // Objects without this symbol are copied as-is, avoiding the broken clone method
      const brokenCloneable = {
        name: "broken",
        clone: () => { throw new Error("Clone failed!"); }
      };

      const parent = new ParentWithChildList({
        name: "parent",
        children: [brokenCloneable as any],
        references: []
      });

      // Should not throw - objects without isProxyEntity symbol are copied as-is
      const cloned = parent.clone();
      expect(cloned.children[0]).toBe(brokenCloneable); // Same reference, not cloned
    });

    it("should handle objects that return invalid clones", () => {
      // With the new implementation using isModelType guard,
      // objects without isProxyEntity symbol are not cloned at all
      const invalidCloneable = {
        name: "invalid",
        clone: () => "not an object" // This won't be called
      };

      const parent = new ParentWithChildList({
        name: "parent",
        children: [invalidCloneable as any],
        references: []
      });

      // Object is copied as-is since it doesn't have isProxyEntity symbol
      const cloned = parent.clone();
      expect(cloned.children[0]).toBe(invalidCloneable); // Same reference
    });

    it("should handle extremely deep nesting without stack overflow", () => {
      // Create a deeply nested structure
      let current = new ChildComponent({ name: "leaf", value: 0 });

      // Build 100 levels deep
      for (let i = 1; i <= 100; i++) {
        current = new ParentWithChildList({
          name: `level${i}`,
          children: [current],
          references: []
        }) as any;
      }

      // Should not stack overflow
      const cloned = (current as any).clone();

      // Verify deep structure is preserved
      let currentCloned = cloned;
      for (let i = 100; i >= 1; i--) {
        expect(currentCloned.name).toBe(`level${i}`);
        expect(currentCloned.children).toHaveLength(1);
        currentCloned = currentCloned.children[0];
      }

      // Should reach the leaf
      expect(currentCloned.name).toBe("leaf");
      expect(currentCloned.value).toBe(0);
    });

    it("should handle concurrent clone operations (single parent constraint)", async () => {
      // Test that multiple clone operations don't interfere with each other's transactions
      const sharedChild = new ChildComponent({ name: "shared", value: 1 });

      const parents = Array.from({ length: 10 }, (_, i) =>
        new ParentWithChildList({
          name: `parent${i}`,
          children: [sharedChild], // Each assignment moves sharedChild to the new parent
          references: []
        })
      );

      // Parent tracking should have moved sharedChild to the last parent
      for (let i = 0; i < 9; i++) {
        expect(parents[i].children).toHaveLength(0); // All previous parents lost the child
      }
      expect(parents[9].children).toHaveLength(1); // Only the last parent has it
      expect(parents[9].children[0]).toBe(sharedChild);

      // Clone all parents concurrently
      const clonePromises = parents.map(parent =>
        Promise.resolve().then(() => parent.clone())
      );

      const clonedParents = await Promise.all(clonePromises);

      // Each clone should be independent
      for (let i = 0; i < 10; i++) {
        expect(clonedParents[i].uuid).not.toBe(parents[i].uuid);
        expect(clonedParents[i].name).toBe(`parent${i}`);
        
        if (i < 9) {
          // First 9 parents should have no children
          expect(clonedParents[i].children).toHaveLength(0);
        } else {
          // Only the last parent should have the cloned child
          expect(clonedParents[i].children).toHaveLength(1);
          expect(clonedParents[i].children[0].uuid).not.toBe(sharedChild.uuid);
          expect(clonedParents[i].children[0].name).toBe("shared");
        }
      }
    });
  });

  describe("ephemeral entity reference behavior", () => {
    it("should keep ephemeral entity ephemeral when referencing stored entity", () => {
      // Create a stored (materialized) entity
      const storedChild = new ChildComponent({ name: "stored", value: 100 });

      // Create ephemeral entity that references the stored one
      const ephemeralParent = new ParentWithChildVal({
        name: "ephemeral",
        child: null,
        reference: storedChild // Ephemeral entity referencing stored entity
      });

      // The ephemeral entity should remain ephemeral despite referencing stored entity
      expect(ephemeralParent.reference).toBe(storedChild);
      expect(ephemeralParent.reference!.name).toBe("stored");

      // Clone the ephemeral parent
      const cloned = ephemeralParent.clone();

      // The cloned ephemeral should still reference the original stored entity
      expect(cloned.reference).toBe(storedChild); // Same reference to stored
      expect(cloned.reference!.uuid).toBe(storedChild.uuid);
    });

    it("should handle mixed ephemeral/materialized in lists - clone child-list but preserve list", () => {
      const materializedChild1 = new ChildComponent({ name: "materialized1", value: 1 });
      const materializedChild2 = new ChildComponent({ name: "materialized2", value: 2 });
      const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 3 });

      const parent = new ParentWithChildList({
        name: "mixed",
        children: [ephemeralChild, materializedChild1], // child-list: should clone both
        references: [ephemeralChild, materializedChild2] // list: should preserve both
      });

      const cloned = parent.clone();

      // child-list: both items should be cloned (even if original was ephemeral)
      expect(cloned.children).toHaveLength(2);
      expect(cloned.children[0].uuid).not.toBe(ephemeralChild.uuid);
      expect(cloned.children[1].uuid).not.toBe(materializedChild1.uuid);
      expect(cloned.children[0].name).toBe("ephemeral");
      expect(cloned.children[1].name).toBe("materialized1");

      // list: both items should be preserved as references (same UUIDs)
      expect(cloned.references).toHaveLength(2);
      expect(cloned.references[0]).toBe(ephemeralChild); // Same reference
      expect(cloned.references[1]).toBe(materializedChild2); // Same reference
      expect(cloned.references[0].uuid).toBe(ephemeralChild.uuid);
      expect(cloned.references[1].uuid).toBe(materializedChild2.uuid);
    });

    it("should handle mixed ephemeral/materialized in records - clone child-record but preserve record", () => {
      const materializedChild = new ChildComponent({ name: "materialized", value: 1 });
      const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 2 });

      const parent = new ParentWithChildRecord({
        name: "mixed",
        childMap: {
          mat: materializedChild,
          eph: ephemeralChild
        }, // child-record: should clone both
        refMap: {
          mat: materializedChild,
          eph: ephemeralChild
        } // record: should preserve both
      });

      const cloned = parent.clone();

      // child-record: both values should be cloned
      expect(Object.keys(cloned.childMap)).toEqual(["mat", "eph"]);
      expect(cloned.childMap.mat.uuid).not.toBe(materializedChild.uuid);
      expect(cloned.childMap.eph.uuid).not.toBe(ephemeralChild.uuid);
      expect(cloned.childMap.mat.name).toBe("materialized");
      expect(cloned.childMap.eph.name).toBe("ephemeral");

      // record: both values should be preserved as references
      expect(cloned.refMap.mat).toBe(materializedChild);
      expect(cloned.refMap.eph).toBe(ephemeralChild);
      expect(cloned.refMap.mat.uuid).toBe(materializedChild.uuid);
      expect(cloned.refMap.eph.uuid).toBe(ephemeralChild.uuid);
    });

    it("should handle mixed ephemeral/materialized in sets - clone child-set but preserve set", () => {
      const materializedChild = new ChildComponent({ name: "materialized", value: 1 });
      const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 2 });

      const parent = new ParentWithChildSet({
        name: "mixed",
        childSet: new Set([materializedChild, ephemeralChild]), // child-set: should clone both
        refSet: new Set([materializedChild, ephemeralChild]) // set: should preserve both
      });

      const cloned = parent.clone();

      // child-set: both items should be cloned
      expect(cloned.childSet.size).toBe(2);
      const clonedChildren = Array.from(cloned.childSet);
      expect(clonedChildren.every(child =>
        child.uuid !== materializedChild.uuid && child.uuid !== ephemeralChild.uuid
      )).toBe(true);
      expect(clonedChildren.some(child => child.name === "materialized")).toBe(true);
      expect(clonedChildren.some(child => child.name === "ephemeral")).toBe(true);

      // set: both items should be preserved as references
      expect(cloned.refSet.size).toBe(2);
      expect(cloned.refSet.has(materializedChild)).toBe(true);
      expect(cloned.refSet.has(ephemeralChild)).toBe(true);
    });
  });
});
