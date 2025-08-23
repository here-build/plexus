/**
 * Comprehensive tests for Set proxy implementation in plexus
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelClass } from "../proxy-runtime.js";
import { ModelType, referenceSymbol } from "../proxy-runtime-types.js";
import * as Y from "yjs";

// Test model with a set field
type TestModelWithSet = ModelType<
  {
    name: string;
    readonly tags: Set<string>;
    readonly components: Set<TestComponent>;
  },
  "TestModelWithSet"
>;

type TestComponent = ModelType<
  {
    name: string;
    version: number;
  },
  "TestComponent"
>;

const TestComponent = buildModelClass<TestComponent>("TestComponent", {
  name: "val",
  version: "val"
});

const TestModelWithSet = buildModelClass<TestModelWithSet>("TestModelWithSet", {
  name: "val",
  tags: "set",
  components: "set"
});

describe("Set Proxy Implementation", () => {
  let doc: Y.Doc;
  let projectId: string;

  beforeEach(() => {
    doc = new Y.Doc();
    (doc as any).rootProjectId = "test-project";
    projectId = "test-project";
  });

  describe("Ephemeral Sets", () => {
    it("should create empty sets", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set()
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
        components: new Set()
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
        components: new Set()
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
          ["tag3", "tag3"]
        ])
      );
    });

    it("should support Set comparison methods", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set()
      });

      const otherSet = new Set(["tag2", "tag3"]);
      const subSet = new Set(["tag1"]);
      const superSet = new Set(["tag1", "tag2", "tag3"]);

      // Test set relationship methods
      expect(model.tags.isDisjointFrom(new Set(["tag3", "tag4"]))).toBe(true);
      expect(model.tags.isDisjointFrom(otherSet)).toBe(false);

      expect(model.tags.isSubsetOf(superSet)).toBe(true);
      expect(model.tags.isSubsetOf(subSet)).toBe(false);

      expect(model.tags.isSupersetOf(subSet)).toBe(true);
      expect(model.tags.isSupersetOf(superSet)).toBe(false);
    });

    it("should support clear operation", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2", "tag3"]),
        components: new Set()
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
        components: new Set([comp1, comp2])
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
    it("should materialize sets to YJS", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1", "tag2"]),
        components: new Set()
      });

      // Materialize by getting reference
      const ref = model[referenceSymbol](projectId, doc as any);
      expect(ref).toEqual([expect.any(String)]);

      // Check that YJS arrays were created
      const yprojectFields = doc.getMap(`project:${projectId}:models`);
      const entityId = ref[0];
      const tagsArray = yprojectFields.get(`${entityId}.tags`) as Y.Array<any>;

      expect(tagsArray).toBeInstanceOf(Y.Array);
      expect(tagsArray.length).toBe(2);
      expect(tagsArray.toArray()).toEqual(expect.arrayContaining(["tag1", "tag2"]));
    });

    it("should sync set changes through YJS", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(["tag1"]),
        components: new Set()
      });

      // Materialize
      const ref = model[referenceSymbol](projectId, doc as any);
      const entityId = ref[0];

      // Get materialized proxy (should be same reference)
      const materializedModel = TestModelWithSet.spawn(entityId, projectId, doc as any);
      expect(materializedModel).toBe(model); // Same object reference

      // Changes should sync through YJS
      materializedModel.tags.add("tag2");
      expect(materializedModel.tags.has("tag2")).toBe(true);
      expect(materializedModel.tags.size).toBe(2);

      // Check YJS backing
      const yprojectFields = doc.getMap(`project:${projectId}:models`);
      const tagsArray = yprojectFields.get(`${entityId}.tags`) as Y.Array<any>;
      expect(tagsArray.length).toBe(2);
      expect(tagsArray.toArray()).toEqual(expect.arrayContaining(["tag1", "tag2"]));
    });

    it("should handle entity sets in materialized state", () => {
      const comp1 = new TestComponent({ name: "Component 1", version: 1 });
      const comp2 = new TestComponent({ name: "Component 2", version: 2 });

      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set([comp1])
      });

      // Materialize
      model[referenceSymbol](projectId, doc as any);

      // Add component to materialized set
      model.components.add(comp2);
      expect(model.components.size).toBe(2);
      expect(model.components.has(comp1)).toBe(true);
      expect(model.components.has(comp2)).toBe(true);

      // Remove component
      expect(model.components.delete(comp1)).toBe(true);
      expect(model.components.size).toBe(1);
      expect(model.components.has(comp1)).toBe(false);
      expect(model.components.has(comp2)).toBe(true);
    });

  });

  describe("Set Edge Cases", () => {
    it("should handle empty sets properly", () => {
      const model = new TestModelWithSet({
        name: "Test Model",
        tags: new Set(),
        components: new Set()
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
        components: new Set()
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
});
