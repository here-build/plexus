/**
 * Comprehensive tests for clone semantics, assign behavior, and clear behavior
 *
 * This file combines tests for:
 * - Ownership-aware cloning with child-list, child-set, child-record schema types
 * - clone(), assign(), clear() methods
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { createTrackedFunction } from "../../tracking.js";
import * as Y from "yjs";

// =============================================================================
// Test Models
// =============================================================================

// Basic test component for simple scenarios
@syncing
class TestComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor version!: number;
}

// Extended test model with various collection types
@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;

  @syncing
  accessor component!: TestComponent | null;

  @syncing.list
  accessor items!: string[];

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.record
  accessor metadata!: Record<string, string>;

  @syncing.set
  accessor references!: Set<TestComponent>;
}

// Edge case models for nested ownership
@syncing
class EdgeCaseParent extends PlexusModel {
  @syncing.child
  accessor value!: EdgeCaseChild;
  @syncing.child
  accessor field!: TestComponent;
}

@syncing
class EdgeCaseChild extends PlexusModel {
  @syncing
  accessor field!: TestComponent;
}

// Ownership-aware models
@syncing
class ChildComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;
}

@syncing
class ParentWithChildVal extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor child!: ChildComponent | null; // Ownership: clone child recursively

  @syncing
  accessor participatingReference!: ChildComponent | null; // No ownership but updated as new entity of that was cloned

  @syncing
  accessor reference!: ChildComponent | null; // No ownership: preserve reference
}

@syncing
class ParentWithChildList extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.list
  accessor children!: Array<ChildComponent>; // Ownership: clone children recursively

  @syncing.list
  accessor references!: Array<ChildComponent>; // No ownership: preserve references
}

@syncing
class ParentWithChildSet extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.set
  accessor childSet!: Set<ChildComponent>; // Ownership: clone children recursively

  @syncing.set
  accessor refSet!: Set<ChildComponent>; // No ownership: preserve references
}

@syncing
class ParentWithChildRecord extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.record
  accessor childMap!: Record<string, ChildComponent>; // Ownership: clone children recursively

  @syncing.record
  accessor refMap!: Record<string, ChildComponent>; // No ownership: preserve references
}

// Circular reference models
@syncing
class NodeA extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor nodeB!: NodeB | null; // Owns NodeB - will clone recursively
}

@syncing
class NodeB extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor nodeA!: NodeA | null; // Owns NodeA - creates circular ownership
}

// =============================================================================
// Clone Semantics Tests
// =============================================================================

describe("Clone semantics", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  describe("basic clone behavior", () => {
    it("should create a new entity with same primitive values", () => {
      const original = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      const cloned = original.clone();

      // Different entities
      expect(cloned.uuid).not.toBe(original.uuid);

      // Same primitive values
      expect({ ...cloned }).toMatchObject({
        name: "test",
        value: 42,
        component: null,
        items: [],
        metadata: {},
      });
      expect([...cloned.tags]).toEqual([]);
      expect([...cloned.references]).toEqual([]);
    });

    it("should shallow clone collections (new collection, same elements)", () => {
      const comp1 = new TestComponent({ name: "comp1", version: 1 });
      const comp2 = new TestComponent({ name: "comp2", version: 2 });

      const original = new TestModel({
        name: "test",
        value: 42,
        component: comp1,
        items: ["a", "b", "c"],
        tags: new Set(["tag1", "tag2"]),
        metadata: { key1: "value1", key2: "value2" },
        references: new Set([comp1, comp2]),
      });

      const cloned = original.clone();

      // Collections are different instances
      expect(cloned.items).not.toBe(original.items);
      expect(cloned.tags).not.toBe(original.tags);
      expect(cloned.metadata).not.toBe(original.metadata);
      expect(cloned.references).not.toBe(original.references);

      // But contain same elements
      expect(cloned).toMatchObject({
        items: ["a", "b", "c"],
        metadata: { key1: "value1", key2: "value2" },
      });
      expect([...cloned.tags]).toEqual(expect.arrayContaining(["tag1", "tag2"]));
      expect([...cloned.references]).toEqual(expect.arrayContaining([comp1, comp2]));
    });

    it("should preserve entity references (not clone referenced entities)", () => {
      const comp = new TestComponent({ name: "referenced", version: 1 });

      const original = new TestModel({
        name: "test",
        value: 42,
        component: comp,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set([comp]),
      });

      const cloned = original.clone();

      // Referenced entity should be the same instance
      expect(cloned.component).toBe(comp);
      expect(cloned.component?.uuid).toBe(comp.uuid);
      expect([...cloned.references]).toContain(comp);

      // Verify it's actually the same reference
      cloned.component!.name = "modified";
      expect(comp.name).toBe("modified");
    });

    it("should trigger access tracking when reading fields during clone", () => {
      const original = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["a", "b"],
        tags: new Set(["tag1"]),
        metadata: { key: "value" },
        references: new Set(),
      });

      const notifyChanges = vi.fn();

      const trackedClone = createTrackedFunction(notifyChanges, () => {
        return original.clone();
      });

      const cloned = trackedClone();
      expect(cloned.name).toBe("test");

      // Modifying fields that were accessed during clone should notify
      original.name = "changed";
      expect(notifyChanges).toHaveBeenCalled();
    });

    it("should properly handle edge case with shared references across child fields", () => {
      const field = new TestComponent({});
      const parent = new EdgeCaseParent({
        value: new EdgeCaseChild({
          field,
        }),
        field,
      }).clone();
      expect(parent.field).not.toBe(field);
      expect(parent.field).toBe(parent.value.field);
    });
  });

  describe("child-val ownership", () => {
    it("should deep clone child-val but preserve val references", () => {
      const child = new ChildComponent({ name: "child", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 1 });

      const parent = new ParentWithChildVal({
        name: "parent",
        child: child, // Will be cloned
        participatingReference: child, // Will be updated as new entity of that was spawned
        reference: child2, // Will be preserved as reference
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
      expect(cloned.participatingReference!.uuid).not.toBe(child.uuid);
      expect(cloned.participatingReference).toBe(cloned.child); // Same object reference
      // val: reference should be preserved (same UUID)
      expect(cloned.reference!.uuid).toBe(child2.uuid);
      expect(cloned.reference).toBe(child2); // Same object reference
    });

    it("should handle null child-val gracefully", () => {
      const parent = new ParentWithChildVal({
        name: "parent",
        child: null,
        reference: null,
      });

      const cloned = parent.clone();

      expect(cloned.child).toBe(null);
      expect(cloned.reference).toBe(null);
    });
  });

  describe("child-list ownership", () => {
    it("should deep clone child-list elements and remap references to cloned entities", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const child3 = new ChildComponent({ name: "child3", value: 3 });

      const parent = new ParentWithChildList({
        name: "parent",
        children: [child1, child2], // Will be cloned
        references: [child1, child2, child3], // child1 and child2 will be remapped to clones, child3 preserved
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

      // list: references to cloned entities should be remapped, non-cloned preserved
      expect(cloned.references).toHaveLength(3);
      expect(cloned.references[0]).toBe(cloned.children[0]); // Remapped to clone
      expect(cloned.references[1]).toBe(cloned.children[1]); // Remapped to clone
      expect(cloned.references[2]).toBe(child3); // Not cloned, so preserved
      expect(cloned.references[2].uuid).toBe(child3.uuid);
    });

    it("should handle modifications to cloned children independently", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });

      const parent = new ParentWithChildList({
        name: "parent",
        children: [child1],
        references: [child1, child2], // child1 will be remapped, child2 preserved
      });

      const cloned = parent.clone();

      // Modify the cloned child
      cloned.children[0].name = "modified";

      // Original child should be unchanged
      expect(child1.name).toBe("child1");
      expect(parent.children[0].name).toBe("child1");

      // Cloned child should be changed
      expect(cloned.children[0].name).toBe("modified");

      // Reference to cloned child should also see the modification (same object)
      expect(cloned.references[0].name).toBe("modified");
      expect(cloned.references[0]).toBe(cloned.children[0]); // Remapped to clone

      // Reference to non-cloned child should be unchanged
      expect(cloned.references[1]).toBe(child2);
      expect(cloned.references[1].name).toBe("child2");
    });
  });

  describe("child-set ownership", () => {
    it("should deep clone child-set elements and remap set references to cloned entities", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const child3 = new ChildComponent({ name: "child3", value: 3 });

      const parent = new ParentWithChildSet({
        name: "parent",
        childSet: new Set([child1, child2]), // Will be cloned
        refSet: new Set([child1, child2, child3]), // child1 and child2 remapped, child3 preserved
      });

      const cloned = parent.clone();

      // child-set: children should be cloned
      expect(cloned.childSet.size).toBe(2);
      const clonedChildren = Array.from(cloned.childSet);
      expect(clonedChildren[0].uuid).not.toBe(child1.uuid);
      expect(clonedChildren[1].uuid).not.toBe(child2.uuid);

      // set: references to cloned entities should be remapped
      expect(cloned.refSet.size).toBe(3);
      expect(cloned.refSet.has(clonedChildren[0])).toBe(true); // Remapped to clone
      expect(cloned.refSet.has(clonedChildren[1])).toBe(true); // Remapped to clone
      expect(cloned.refSet.has(child3)).toBe(true); // Not cloned, preserved
      expect(cloned.refSet.has(child1)).toBe(false); // Original no longer in set
      expect(cloned.refSet.has(child2)).toBe(false); // Original no longer in set
    });
  });

  describe("child-record ownership", () => {
    it("should deep clone child-record values and remap record references to cloned entities", () => {
      const child1 = new ChildComponent({ name: "child1", value: 1 });
      const child2 = new ChildComponent({ name: "child2", value: 2 });
      const child3 = new ChildComponent({ name: "child3", value: 3 });

      const parent = new ParentWithChildRecord({
        name: "parent",
        childMap: { first: child1, second: child2 }, // Will be cloned
        refMap: { first: child1, second: child2, third: child3 }, // first and second remapped, third preserved
      });

      const cloned = parent.clone();

      // child-record: values should be cloned
      expect(Object.keys(cloned.childMap)).toEqual(["first", "second"]);
      expect(cloned.childMap.first.uuid).not.toBe(child1.uuid);
      expect(cloned.childMap.second.uuid).not.toBe(child2.uuid);
      expect(cloned.childMap.first.name).toBe("child1"); // Same values
      expect(cloned.childMap.second.name).toBe("child2");

      // record: references to cloned entities should be remapped
      expect(Object.keys(cloned.refMap)).toEqual(["first", "second", "third"]);
      expect(cloned.refMap.first).toBe(cloned.childMap.first); // Remapped to clone
      expect(cloned.refMap.second).toBe(cloned.childMap.second); // Remapped to clone
      expect(cloned.refMap.third).toBe(child3); // Not cloned, preserved
      expect(cloned.refMap.third.uuid).toBe(child3.uuid);
    });
  });
});

// =============================================================================
// Circular and Edge Case Tests
// =============================================================================

describe("Circular ownership edge cases", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
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
      references: [],
    });

    // At this point, sharedChild belongs to parent1
    expect(parent1.children).toHaveLength(1);
    expect(parent1.children[0]).toBe(sharedChild);

    const parent2 = new ParentWithChildList({
      name: "parent2",
      children: [sharedChild, parent1], // sharedChild moves to parent2, removed from parent1
      references: [],
    });

    // Parent tracking should have moved sharedChild from parent1 to parent2
    expect(parent1.children).toHaveLength(0); // Empty - sharedChild was removed
    expect(parent2.children).toHaveLength(2);
    expect(parent2.children[0]).toBe(sharedChild);
    expect(parent2.children[1] as any).toBe(parent1);

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
      references: [],
    });

    // leafChild belongs to level2a
    expect(level2a.children).toHaveLength(1);
    expect(level2a.children[0]).toBe(leafChild);

    const level2b = new ParentWithChildList({
      name: "level2b",
      children: [leafChild], // leafChild moves from level2a to level2b
      references: [],
    });

    // Parent tracking should have moved leafChild from level2a to level2b
    expect(level2a.children).toHaveLength(0); // Empty - leafChild was moved
    expect(level2b.children).toHaveLength(1);
    expect(level2b.children[0]).toBe(leafChild);

    const root = new ParentWithChildList({
      name: "root",
      children: [level2a, level2b], // level2a has no children, level2b has leafChild
      references: [],
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

  it("should prevent self-referential collections", () => {
    // Plexus now prevents self-referential ownership (would create cycle)
    // Attempting to add an entity to its own child collection throws an error

    // Test a parent that tries to contain itself in its children list
    const selfRef = new ParentWithChildList({
      name: "selfRef",
      children: [], // Start empty, will try to add self via push
      references: [],
    });

    // Attempting to add itself to its own children list should throw
    expect(() => {
      selfRef.children.push(selfRef as any);
    }).toThrow(/self|cycle/i);

    // Verify no self-reference was created
    expect(selfRef.children).toHaveLength(0);
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
      references: [],
    });

    // shared belongs to left
    expect(left.children).toHaveLength(1);
    expect(left.children[0]).toBe(shared);

    const right = new ParentWithChildList({
      name: "right",
      children: [shared], // shared moves from left to right
      references: [],
    });

    // Parent tracking should have moved shared from left to right
    expect(left.children).toHaveLength(0); // Empty - shared was moved
    expect(right.children).toHaveLength(1);
    expect(right.children[0]).toBe(shared);

    const root = new ParentWithChildList({
      name: "root",
      children: [left, right], // left has no children, right has shared
      references: [],
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

  it("should handle mixed ownership and reference semantics with remapping", () => {
    const sharedChild = new ChildComponent({ name: "shared", value: 100 });
    const otherChild = new ChildComponent({ name: "other", value: 200 });

    const mixedParent = new ParentWithChildList({
      name: "mixed",
      children: [sharedChild], // child-list: will clone
      references: [sharedChild, otherChild], // list: sharedChild remapped, otherChild preserved
    });

    const cloned = mixedParent.clone();

    // The child in children should be cloned
    expect(cloned.children[0].uuid).not.toBe(sharedChild.uuid);
    expect(cloned.children[0].name).toBe("shared");
    expect(cloned.children[0].value).toBe(100);

    // The child in references should be remapped to the clone
    expect(cloned.references[0]).toBe(cloned.children[0]); // Remapped to clone
    expect(cloned.references[0].uuid).toBe(cloned.children[0].uuid);

    // The other reference should be preserved
    expect(cloned.references[1]).toBe(otherChild);
    expect(cloned.references[1].uuid).toBe(otherChild.uuid);
  });

  it("should handle empty collections properly", () => {
    const parent = new ParentWithChildList({
      name: "empty",
      children: [],
      references: [],
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
      reference: null,
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
      references: [],
    });

    // First clone
    const cloned1 = parent1.clone();
    expect(cloned1.children[0].uuid).not.toBe(child1.uuid);

    // Second clone should start fresh (not reuse previous mapping)
    const child2 = new ChildComponent({ name: "child2", value: 2 });
    const parent2 = new ParentWithChildList({
      name: "parent2",
      children: [child2],
      references: [],
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
      parents.push(
        new ParentWithChildList({
          name: `parent${i}`,
          children: [centralChild], // Each assignment moves centralChild to the new parent
          references: [],
        }),
      );
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
      references: [],
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

// =============================================================================
// Mixed Scenarios Tests
// =============================================================================

describe("Mixed clone scenarios", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should handle non-cloneable items gracefully", () => {
    const parent = new ParentWithChildList({
      name: "parent",
      children: [
        new ChildComponent({ name: "cloneable", value: 1 }),
        "string value" as any, // Non-cloneable
        42 as any, // Non-cloneable
        null as any, // Non-cloneable
      ],
      references: [],
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
      clone: () => {
        throw new Error("Clone failed!");
      },
    };

    const parent = new ParentWithChildList({
      name: "parent",
      children: [brokenCloneable as any],
      references: [],
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
      clone: () => "not an object", // This won't be called
    };

    const parent = new ParentWithChildList({
      name: "parent",
      children: [invalidCloneable as any],
      references: [],
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
        references: [],
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

    const parents = Array.from(
      { length: 10 },
      (_, i) =>
        new ParentWithChildList({
          name: `parent${i}`,
          children: [sharedChild], // Each assignment moves sharedChild to the new parent
          references: [],
        }),
    );

    // Parent tracking should have moved sharedChild to the last parent
    for (let i = 0; i < 9; i++) {
      expect(parents[i].children).toHaveLength(0); // All previous parents lost the child
    }
    expect(parents[9].children).toHaveLength(1); // Only the last parent has it
    expect(parents[9].children[0]).toBe(sharedChild);

    // Clone all parents concurrently
    const clonePromises = parents.map((parent) => Promise.resolve().then(() => parent.clone()));

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

// =============================================================================
// Ephemeral Entity Reference Tests
// =============================================================================

describe("Ephemeral entity reference behavior", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should keep ephemeral entity ephemeral when referencing stored entity", () => {
    // Create a stored (materialized) entity
    const storedChild = new ChildComponent({ name: "stored", value: 100 });

    // Create ephemeral entity that references the stored one
    const ephemeralParent = new ParentWithChildVal({
      name: "ephemeral",
      child: null,
      reference: storedChild, // Ephemeral entity referencing stored entity
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

  it("should handle mixed ephemeral/materialized in lists - clone child-list and remap references", () => {
    const materializedChild1 = new ChildComponent({ name: "materialized1", value: 1 });
    const materializedChild2 = new ChildComponent({ name: "materialized2", value: 2 });
    const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 3 });

    const parent = new ParentWithChildList({
      name: "mixed",
      children: [ephemeralChild, materializedChild1], // child-list: should clone both
      references: [ephemeralChild, materializedChild2], // list: ephemeralChild remapped, materializedChild2 preserved
    });

    const cloned = parent.clone();

    // child-list: both items should be cloned (even if original was ephemeral)
    expect(cloned.children).toHaveLength(2);
    expect(cloned.children[0].uuid).not.toBe(ephemeralChild.uuid);
    expect(cloned.children[1].uuid).not.toBe(materializedChild1.uuid);
    expect(cloned.children[0].name).toBe("ephemeral");
    expect(cloned.children[1].name).toBe("materialized1");

    // list: ephemeralChild should be remapped, materializedChild2 preserved
    expect(cloned.references).toHaveLength(2);
    expect(cloned.references[0]).toBe(cloned.children[0]); // Remapped to clone
    expect(cloned.references[1]).toBe(materializedChild2); // Not cloned, preserved
    expect(cloned.references[0].uuid).toBe(cloned.children[0].uuid);
    expect(cloned.references[1].uuid).toBe(materializedChild2.uuid);
  });

  it("should handle mixed ephemeral/materialized in records - clone child-record and remap references", () => {
    const materializedChild = new ChildComponent({ name: "materialized", value: 1 });
    const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 2 });
    const otherChild = new ChildComponent({ name: "other", value: 3 });

    const parent = new ParentWithChildRecord({
      name: "mixed",
      childMap: {
        mat: materializedChild,
        eph: ephemeralChild,
      }, // child-record: should clone both
      refMap: {
        mat: materializedChild,
        eph: ephemeralChild,
        other: otherChild,
      }, // record: mat and eph remapped, other preserved
    });

    const cloned = parent.clone();

    // child-record: both values should be cloned
    expect(Object.keys(cloned.childMap)).toEqual(["mat", "eph"]);
    expect(cloned.childMap.mat.uuid).not.toBe(materializedChild.uuid);
    expect(cloned.childMap.eph.uuid).not.toBe(ephemeralChild.uuid);
    expect(cloned.childMap.mat.name).toBe("materialized");
    expect(cloned.childMap.eph.name).toBe("ephemeral");

    // record: cloned values should be remapped, other preserved
    expect(Object.keys(cloned.refMap)).toEqual(["mat", "eph", "other"]);
    expect(cloned.refMap.mat).toBe(cloned.childMap.mat); // Remapped to clone
    expect(cloned.refMap.eph).toBe(cloned.childMap.eph); // Remapped to clone
    expect(cloned.refMap.other).toBe(otherChild); // Not cloned, preserved
    expect(cloned.refMap.mat.uuid).toBe(cloned.childMap.mat.uuid);
    expect(cloned.refMap.eph.uuid).toBe(cloned.childMap.eph.uuid);
    expect(cloned.refMap.other.uuid).toBe(otherChild.uuid);
  });

  it("should handle mixed ephemeral/materialized in sets - clone child-set and remap references", () => {
    const materializedChild = new ChildComponent({ name: "materialized", value: 1 });
    const ephemeralChild = new ChildComponent({ name: "ephemeral", value: 2 });
    const otherChild = new ChildComponent({ name: "other", value: 3 });

    const parent = new ParentWithChildSet({
      name: "mixed",
      childSet: new Set([materializedChild, ephemeralChild]), // child-set: should clone both
      refSet: new Set([materializedChild, ephemeralChild, otherChild]), // set: mat and eph remapped, other preserved
    });

    const cloned = parent.clone();

    // child-set: both items should be cloned
    expect(cloned.childSet.size).toBe(2);
    const clonedChildren = Array.from(cloned.childSet);
    expect(
      clonedChildren.every((child) => child.uuid !== materializedChild.uuid && child.uuid !== ephemeralChild.uuid),
    ).toBe(true);
    expect(clonedChildren.some((child) => child.name === "materialized")).toBe(true);
    expect(clonedChildren.some((child) => child.name === "ephemeral")).toBe(true);

    // set: cloned items should be remapped, other preserved
    expect(cloned.refSet.size).toBe(3);
    expect(cloned.refSet.has(clonedChildren[0])).toBe(true); // One of the clones
    expect(cloned.refSet.has(clonedChildren[1])).toBe(true); // Other clone
    expect(cloned.refSet.has(otherChild)).toBe(true); // Not cloned, preserved
    expect(cloned.refSet.has(materializedChild)).toBe(false); // Original not in set
    expect(cloned.refSet.has(ephemeralChild)).toBe(false); // Original not in set
  });
});

// =============================================================================
// Assign Behavior Tests
// =============================================================================

describe("Assign behavior", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  describe("array.assign()", () => {
    it("should replace entire array contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old1", "old2", "old3"],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      const newItems = ["new1", "new2"];
      model.items = newItems;

      expect(model.items).toEqual(["new1", "new2"]);
      expect(model.items).not.toBe(newItems);
      newItems.push("new3");
      expect(model.items).toEqual(["new1", "new2"]);
    });

    it("should handle empty array assignment", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["item1", "item2"],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      model.items = [];
      expect(model.items).toEqual([]);
      expect(model.items.length).toBe(0);
    });

    it("should trigger modification tracking", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: ["old"],
        tags: new Set(),
        metadata: {},
        references: new Set(),
      });

      const notifyChanges = vi.fn();

      const trackedRead = createTrackedFunction(notifyChanges, () => {
        return model.items.length;
      });

      expect(trackedRead()).toBe(1);

      model.items = ["new1", "new2"];
      expect(notifyChanges).toHaveBeenCalled();
    });
  });

  describe("set.assign()", () => {
    it("should replace entire set contents", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["old1", "old2"]),
        metadata: {},
        references: new Set(),
      });

      model.tags = new Set(["new1", "new2", "new3"]);

      expect([...model.tags]).toEqual(expect.arrayContaining(["new1", "new2", "new3"]));
    });

    it("should handle duplicate values in assignment (maintains set uniqueness)", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(["old"]),
        metadata: {},
        references: new Set(),
      });

      model.tags = new Set(["new1", "new2", "new1", "new2"]);
      expect([...model.tags]).toEqual(expect.arrayContaining(["new1", "new2"]));
      expect(model.tags.size).toBe(2);
    });

    it("should work with entity references", () => {
      const comp1 = new TestComponent({ name: "comp1", version: 1 });
      const comp2 = new TestComponent({ name: "comp2", version: 2 });
      const comp3 = new TestComponent({ name: "comp3", version: 3 });

      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: {},
        references: new Set([comp1]),
      });

      model.references = new Set([comp2, comp3]);
      expect([...model.references]).toEqual(expect.arrayContaining([comp2, comp3]));
      expect(model.references.has(comp1)).toBe(false);
      expect(model.references.has(comp2)).toBe(true);
      expect(model.references.has(comp3)).toBe(true);
    });
  });

  describe("map.assign()", () => {
    it("should replace entire map contents with Record object", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { old1: "value1", old2: "value2" },
        references: new Set(),
      });

      model.metadata = { new1: "newValue1", new2: "newValue2" };

      expect(model.metadata).toEqual({ new1: "newValue1", new2: "newValue2" });
      expect(Object.keys(model.metadata)).toEqual(["new1", "new2"]);
    });

    it("should handle empty assignment", () => {
      const model = new TestModel({
        name: "test",
        value: 42,
        component: null,
        items: [],
        tags: new Set(),
        metadata: { existing: "value" },
        references: new Set(),
      });

      model.metadata = {};
      expect(model.metadata).toEqual({});
      expect(Object.keys(model.metadata)).toEqual([]);
    });
  });
});

// =============================================================================
// Clear Behavior Tests
// =============================================================================

describe("Clear behavior", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should clear set contents", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: [],
      tags: new Set(["tag1", "tag2", "tag3"]),
      metadata: {},
      references: new Set(),
    });

    const result = model.tags.clear();
    expect(model.tags.size).toBe(0);
    expect([...model.tags]).toEqual([]);
    expect(result).toBe(undefined); // Native Set.clear() returns undefined
  });

  it("should clear map contents via empty assignment", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: [],
      tags: new Set(),
      metadata: { key1: "value1", key2: "value2" },
      references: new Set(),
    });

    model.metadata = {};
    expect(model.metadata).toEqual({});
    expect(Object.keys(model.metadata)).toEqual([]);
  });

  it("should handle clearing empty collections", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: [],
      tags: new Set(),
      metadata: {},
      references: new Set(),
    });

    expect(model.tags.clear()).toBe(undefined); // Native Set.clear() returns undefined
    model.metadata = {};
    expect(model.tags.size).toBe(0);
    expect(Object.keys(model.metadata)).toEqual([]);
  });
});

// =============================================================================
// Method Combinations Tests
// =============================================================================

describe("Method combinations", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  it("should work with clone and assign together", () => {
    const original = new TestModel({
      name: "original",
      value: 100,
      component: null,
      items: ["item1", "item2"],
      tags: new Set(["tag1"]),
      metadata: { key: "value" },
      references: new Set(),
    });

    const cloned = original.clone();

    // Modify the cloned entity collections
    cloned.items = ["new1", "new2", "new3"];
    cloned.tags = new Set(["newTag1", "newTag2"]);
    cloned.metadata = { newKey: "newValue" };

    // Original should be unchanged
    expect(original.items).toEqual(["item1", "item2"]);
    expect([...original.tags]).toEqual(["tag1"]);
    expect(original.metadata).toEqual({ key: "value" });

    // Cloned should have new values
    expect(cloned.items).toEqual(["new1", "new2", "new3"]);
    expect([...cloned.tags]).toEqual(expect.arrayContaining(["newTag1", "newTag2"]));
    expect(cloned.metadata).toEqual({ newKey: "newValue" });
  });

  it("should work with clear and assign together", () => {
    const model = new TestModel({
      name: "test",
      value: 42,
      component: null,
      items: ["old1", "old2"],
      tags: new Set(["oldTag1", "oldTag2"]),
      metadata: { oldKey1: "oldValue1", oldKey2: "oldValue2" },
      references: new Set(),
    });

    // Clear everything
    model.tags.clear();
    model.metadata = {};

    expect(model.tags.size).toBe(0);
    expect(Object.keys(model.metadata)).toEqual([]);

    // Then assign new values
    model.items = ["new1"];
    model.tags = new Set(["newTag"]);
    model.metadata = { newKey: "newValue" };

    expect(model.items).toEqual(["new1"]);
    expect([...model.tags]).toEqual(["newTag"]);
    expect(model.metadata).toEqual({ newKey: "newValue" });
  });
});
