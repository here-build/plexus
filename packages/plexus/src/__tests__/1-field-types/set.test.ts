/**
 * Comprehensive tests for Set proxy implementation in plexus
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { Storageable } from "../../proxy-runtime-types.js";
import * as Y from "yjs";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import * as YJS_GLOBALS from "../../YJS_GLOBALS.js";

// Test model with a set field
@syncing
class TestComponent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor version!: number;
}

@syncing
class TestModelWithSet extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.set
  accessor tags!: Set<string>;

  @syncing.set
  accessor components!: Set<TestComponent>;
}

describe("Set Proxy Implementation", () => {
  let doc: Y.Doc;

  beforeEach(async () => {
    // Just create a basic doc for the non-materialized tests
    doc = new Y.Doc();
  });

  describe("Ephemeral Sets", () => {
    it("should create empty sets", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set(),
      });

      expect(model.tags).toBeInstanceOf(Set);
      expect(model.components).toBeInstanceOf(Set);
      expect(model.tags.size).toBe(0);
      expect(model.components.size).toBe(0);
    });

    it("should support basic Set operations", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set(),
      });

      // Basic set operations
      expect(model.tags.has("tag1")).toBe(true);
      expect(model.tags.has("tag3")).toBe(false);
      expect(model.tags.size).toBe(2);

      // Add operation
      model.tags.add("tag3");
      expect(model.tags.has("tag3")).toBe(true);
      expect(model.tags.size).toBe(3);

      // Delete operation
      expect(model.tags.delete("tag1")).toBe(true);
      expect(model.tags.has("tag1")).toBe(false);
      expect(model.tags.size).toBe(2);

      // Delete non-existent
      expect(model.tags.delete("nonexistent")).toBe(false);
    });

    it("should support Set iteration methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set(),
      });

      // Test values()
      const values = Array.from(model.tags.values());
      expect(values).toEqual(expect.arrayContaining(["tag1", "tag2", "tag3"]));

      // Test forEach
      const collected: string[] = [];
      model.tags.forEach((value) => collected.push(value));
      expect(collected).toEqual(expect.arrayContaining(["tag1", "tag2", "tag3"]));

      // Test entries()
      const entries = Array.from(model.tags.entries());
      expect(entries).toEqual(
        expect.arrayContaining([
          ["tag1", "tag1"],
          ["tag2", "tag2"],
          ["tag3", "tag3"],
        ]),
      );
    });

    const hasSetComparators =
      typeof (new Set() as any).isDisjointFrom === "function" &&
      typeof (new Set() as any).isSubsetOf === "function" &&
      typeof (new Set() as any).isSupersetOf === "function";

    (hasSetComparators ? it : it.skip)("should support Set comparison methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set(),
      });

      const otherSet = new Set(["tag2", "tag3"]);
      const subSet = new Set(["tag1"]);
      const superSet = new Set(["tag1", "tag2", "tag3"]);

      // Test set relationship methods
      expect((model.tags as any).isDisjointFrom(new Set(["tag3", "tag4"]))).toBe(true);
      expect((model.tags as any).isDisjointFrom(otherSet)).toBe(false);

      expect((model.tags as any).isSubsetOf(superSet)).toBe(true);
      expect((model.tags as any).isSubsetOf(subSet)).toBe(false);

      expect((model.tags as any).isSupersetOf(subSet)).toBe(true);
      expect((model.tags as any).isSupersetOf(superSet)).toBe(false);
    });

    it("should support clear operation", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set(),
      });

      expect(model.tags.size).toBe(3);
      model.tags.clear();
      expect(model.tags.size).toBe(0);
      expect(model.tags.has("tag1")).toBe(false);
    });

    it("should work with entity sets", () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1, comp2]),
      });

      expect(model.components.size).toBe(2);
      expect(model.components.has(comp1)).toBe(true);
      expect(model.components.has(comp2)).toBe(true);

      // Add another component
      const comp3 = new TestComponent({ name: "Component 3", version: 3 });
      model.components.add(comp3);
      expect(model.components.size).toBe(3);
      expect(model.components.has(comp3)).toBe(true);

      // Remove a component
      expect(model.components.delete(comp1)).toBe(true);
      expect(model.components.has(comp1)).toBe(false);
      expect(model.components.size).toBe(2);
    });
  });

  describe("Materialized Sets (YJS-backed)", () => {
    it("should materialize sets to YJS", async () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set(),
      });

      // Materialize via Plexus
      const { doc: plexusDoc, root } = await initTestPlexus<TestModelWithSet>(model);

      // Verify the loaded root has correct data
      expect(root.name).toBe("Test Model");
      expect(root.tags.size).toBe(2);
      expect(root.tags.has("tag1")).toBe(true);
      expect(root.tags.has("tag2")).toBe(true);

      // Check that YJS arrays were created
      const yprojectFields = plexusDoc.getMap<Y.Map<Storageable>>("models");
      const entityId = root.uuid;
      const tagsArray = (
        yprojectFields.get(entityId)?.get(YJS_GLOBALS.models.recordFields.fields) as undefined | Y.Map<Y.Array<any>>
      )?.get("tags") as Y.Array<any>;

      expect(tagsArray).toBeInstanceOf(Y.Array);
      expect(tagsArray.length).toBe(2);
      expect(tagsArray.toArray()).toEqual(expect.arrayContaining(["tag1", "tag2"]));
    });

    it("should sync set changes through YJS", async () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set(),
      });

      // Materialize via Plexus
      const { doc: plexusDoc, root } = await initTestPlexus<TestModelWithSet>(model);

      // Verify initial state
      expect(root.tags.has("tag1")).toBe(true);
      expect(root.tags.size).toBe(1);

      // Changes should sync through YJS
      root.tags.add("tag2");
      expect(root.tags.has("tag2")).toBe(true);
      expect(root.tags.size).toBe(2);

      // Check YJS backing
      const yprojectFields = plexusDoc.getMap<Y.Map<Storageable>>("models");
      const entityId = root.uuid;
      const tagsArray = (yprojectFields.get(entityId)?.get("fields") as undefined | Y.Map<Y.Array<any>>)?.get("tags");
      expect(tagsArray?.length).toBe(2);
      expect(tagsArray?.toArray()).toEqual(expect.arrayContaining(["tag1", "tag2"]));
    });

    it("should handle entity sets in materialized state", async () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1]),
      });

      // Materialize via Plexus
      const { root } = await initTestPlexus<TestModelWithSet>(model);

      // Verify initial component set
      expect(root.components.size).toBe(1);
      expect(root.components.has(comp1)).toBe(true);

      // Add component to materialized set
      root.components.add(comp2);
      expect(root.components.size).toBe(2);
      expect(root.components.has(comp1)).toBe(true);
      expect(root.components.has(comp2)).toBe(true);

      // Remove component
      expect(root.components.delete(comp1)).toBe(true);
      expect(root.components.size).toBe(1);
      expect(root.components.has(comp1)).toBe(false);
      expect(root.components.has(comp2)).toBe(true);
    });
  });

  describe("Set Edge Cases", () => {
    it("should handle empty sets properly", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set(),
      });

      expect(model.tags.size).toBe(0);
      expect(model.tags.clear()).toBe(undefined); // Native Set.clear() returns undefined
      expect(model.tags.delete("nonexistent")).toBe(false);
      expect(model.tags.has("anything")).toBe(false);

      // Iteration should work on empty sets
      const values = Array.from(model.tags.values());
      expect(values).toEqual([]);

      const collected: string[] = [];
      model.tags.forEach((value) => collected.push(value));
      expect(collected).toEqual([]);
    });

    it("should maintain Set uniqueness", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set(),
      });

      // Adding duplicate should not increase size
      model.tags.add("tag1");
      expect(model.tags.size).toBe(1);
      expect(model.tags.has("tag1")).toBe(true);

      // Should work with entities too
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      model.components.add(comp1);
      model.components.add(comp1); // Adding same entity
      expect(model.components.size).toBe(1);
      expect(model.components.has(comp1)).toBe(true);
    });
  });

  describe("Child Set (@syncing.child.set)", () => {
    @syncing
    class SetTreeNode extends PlexusModel {
      @syncing accessor name!: string;
      @syncing.child.set accessor children!: Set<SetTreeNode>;
    }

    describe("Basic operations", () => {
      it("should add and track children", () => {
        const child1 = new SetTreeNode({ name: "child1", children: new Set() });
        const child2 = new SetTreeNode({ name: "child2", children: new Set() });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child1, child2]) });

        const { root } = initTestPlexus(rootNode);
        expect(root.children.size).toBe(2);
        expect(root.children.has(child1)).toBe(true);
        expect(root.children.has(child2)).toBe(true);

        // Children should know their parent
        expect(child1.parent).toBe(root);
        expect(child2.parent).toBe(root);
      });

      it("should orphan children on delete", () => {
        const child = new SetTreeNode({ name: "child", children: new Set() });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        expect(child.parent).toBe(root);

        root.children.delete(child);
        expect(child.parent).toBeNull();
        expect(root.children.size).toBe(0);
      });

      it("should orphan all children on clear", () => {
        const child1 = new SetTreeNode({ name: "child1", children: new Set() });
        const child2 = new SetTreeNode({ name: "child2", children: new Set() });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child1, child2]) });

        const { root } = initTestPlexus(rootNode);
        root.children.clear();

        expect(child1.parent).toBeNull();
        expect(child2.parent).toBeNull();
        expect(root.children.size).toBe(0);
      });

      it("should detect cycles on add", () => {
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set() });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];

        // grandchild tries to add child (its ancestor) - would create cycle
        expect(() => {
          grandchildNode.children.add(childNode);
        }).toThrow(/would create cycle/i);
      });
    });

    describe("State consistency on failed adoption", () => {
      it("add: should not corrupt state when adoption fails", () => {
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set() });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];

        // grandchild tries to add child (its ancestor) - would create cycle
        expect(() => {
          grandchildNode.children.add(childNode);
        }).toThrow(/would create cycle/i);

        // State should be unchanged
        expect(grandchildNode.children.size).toBe(0);
        expect(childNode.parent).toBe(root);
        expect(grandchildNode.parent).toBe(childNode);
      });

      it("assign: should not orphan existing items when new items adoption fails", () => {
        const item1 = new SetTreeNode({ name: "item1", children: new Set() });
        const item2 = new SetTreeNode({ name: "item2", children: new Set() });
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set([item1, item2]) });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];
        const item1Node = [...grandchildNode.children].find((c) => c.name === "item1")!;
        const item2Node = [...grandchildNode.children].find((c) => c.name === "item2")!;
        const newItem = new SetTreeNode({ name: "new", children: new Set() });

        // grandchild tries to assign including child (its ancestor) - would create cycle
        expect(() => {
          grandchildNode.children = new Set([newItem, childNode]);
        }).toThrow(/would create cycle/i);

        // Original items should still be properly parented
        expect(item1Node.parent).toBe(grandchildNode);
        expect(item2Node.parent).toBe(grandchildNode);
        expect(grandchildNode.children.size).toBe(2);
        expect(grandchildNode.children.has(item1Node)).toBe(true);
        expect(grandchildNode.children.has(item2Node)).toBe(true);
        // newItem should not have been adopted
        expect(newItem.parent).toBeNull();
        // childNode should still be parented to root
        expect(childNode.parent).toBe(root);
      });

      it("assign: should preserve state when valid item in batch but invalid item throws", () => {
        const grandchild = new SetTreeNode({ name: "grandchild", children: new Set() });
        const child = new SetTreeNode({ name: "child", children: new Set([grandchild]) });
        const rootNode = new SetTreeNode({ name: "root", children: new Set([child]) });

        const { root } = initTestPlexus(rootNode);
        const childNode = [...root.children][0];
        const grandchildNode = [...childNode.children][0];
        const validItem = new SetTreeNode({ name: "valid", children: new Set() });

        // Try to assign one valid item and one invalid (ancestor)
        expect(() => {
          grandchildNode.children = new Set([validItem, childNode]);
        }).toThrow(/would create cycle/i);

        // Neither item should have been added
        expect(grandchildNode.children.size).toBe(0);
        expect(validItem.parent).toBeNull();
        expect(childNode.parent).toBe(root);
      });
    });
  });
});
