import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { load } from "../load.js";
import { YJS_GLOBALS } from "../YJS_GLOBALS.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";

// Test types with various child-* field configurations
type Child = ModelType<{ name: string }, "Child">;
type Parent = ModelType<
  {
    name: string;
    child: Child | null; // child-val
    readonly children: Child[]; // child-list
    readonly childSet: Set<Child>; // child-set
    readonly childMap: Record<string, Child>; // child-record
  },
  "Parent"
>;

type MultiParent = ModelType<
  {
    name: string;
    readonly leftChildren: Child[];
    readonly rightChildren: Child[];
  },
  "MultiParent"
>;

const Child = buildModelClass<Child>("Child", { name: "val" });
const Parent = buildModelClass<Parent>("Parent", {
  name: "val",
  child: "child-val",
  children: "child-list",
  childSet: "child-set",
  childMap: "child-record"
});
const MultiParent = buildModelClass<MultiParent>("MultiParent", {
  name: "val",
  leftChildren: "child-list",
  rightChildren: "child-list"
});

describe("Parent Tracking", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    primeDoc(doc);
  });

  describe("Basic parent assignment", () => {
    it("tracks parent when child assigned to child-val field", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.child = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);
      console.log("Child UUID:", child.uuid);
      console.log("Parent UUID:", parent.uuid);
      console.log("Child fields:", childFields);
      console.log("Child fields entries:", childFields ? Array.from(childFields.entries()) : "none");
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);
      console.log("Parent ref:", parentRef);

      expect(parentRef).toEqual([parent.uuid, `child`]);
    });

    it("tracks parent when child added to child-list", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.children.push(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);

      expect(models.get(child.uuid!).toJSON()).toMatchObject({
        [YJS_GLOBALS.modelMetadataParent]: [parent.uuid, "children"]
      });
    });

    it("tracks parent when child added to child-set", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.childSet.add(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([parent.uuid, "childSet"]);
    });

    it("tracks parent when child added to child-record", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.childMap["key1"] = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);

      expect(childFields?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, "childMap", "key1"]);
    });
  });

  describe("Reparenting", () => {
    it("removes from old parent when assigned to new parent", () => {
      const parent1 = new Parent({
        name: "parent1",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const parent2 = new Parent({
        name: "parent2",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent1[referenceSymbol](doc);
      parent2[referenceSymbol](doc);

      // First assignment
      parent1.children.push(child);
      expect(parent1.children).toContain(child);

      // Reparent
      parent2.child = child;

      // Should be removed from parent1.children
      expect(parent1.children).not.toContain(child);
      expect(parent2.child).toBe(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([parent2.uuid, `child`]);
    });

    it("handles moving between different collection types", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);

      // list → set
      parent.children.push(child);
      expect(parent.children).toContain(child);

      parent.childSet.add(child);
      expect(parent.children).not.toContain(child);
      expect(parent.childSet.has(child)).toBe(true);

      // set → record
      parent.childMap["key"] = child;
      expect(parent.childSet.has(child)).toBe(false);
      expect(parent.childMap["key"]).toBe(child);

      // record → val
      parent.child = child;
      expect(parent.childMap["key"]).toBeUndefined();
      expect(parent.child).toBe(child);
    });

    it("handles moving within same list", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });
      const other1 = new Child({ name: "other1" });
      const other2 = new Child({ name: "other2" });

      parent[referenceSymbol](doc);

      parent.children.push(other1, child, other2);
      expect(parent.children.indexOf(child)).toBe(1);

      // Move to end by pushing again
      parent.children.push(child);
      expect(parent.children.indexOf(child)).toBe(2); // Should be at end now
      expect(parent.children.filter((c) => c === child).length).toBe(1); // Only one instance
    });

    it("handles moving between record keys", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);

      parent.childMap["key1"] = child;
      expect(parent.childMap["key1"]).toBe(child);

      parent.childMap["key2"] = child;
      expect(parent.childMap["key1"]).toBeUndefined();
      expect(parent.childMap["key2"]).toBe(child);
    });
  });

  describe("Null and clear operations", () => {
    it("clears parent ref when child-val set to null", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.child = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      let childFields = models.get(child.uuid!);
      expect(childFields?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();

      parent.child = null;
      childFields = models.get(child.uuid!);
      expect(childFields?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("clears parent refs when list cleared", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      parent[referenceSymbol](doc);
      parent.children.push(child1, child2);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();
      expect(models.get(child2.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();

      parent.children.clear();

      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
      expect(models.get(child2.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("clears parent refs when record reassigned", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      parent[referenceSymbol](doc);
      parent.childMap["a"] = child1;
      parent.childMap["b"] = child2;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();
      expect(models.get(child2.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();

      parent.childMap.assign({});

      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
      expect(models.get(child2.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });
  });

  describe("Cycles", () => {
    it("handles direct cycle (A.child = B, B.child = A)", () => {
      const a = new Parent({
        name: "a",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const b = new Parent({
        name: "b",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      a[referenceSymbol](doc);
      b[referenceSymbol](doc);

      a.child = b;
      b.child = a;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const aParentRef = models.get(a.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      const bParentRef = models.get(b.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);

      expect(aParentRef).toEqual([b.uuid, `child`]);
      expect(bParentRef).toEqual([a.uuid, `child`]);
    });

    it("handles self-reference", () => {
      const self = new Parent({
        name: "self",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      self[referenceSymbol](doc);
      self.child = self;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(self.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([self.uuid, `child`]);
    });

    it("handles cycle through collections", () => {
      const a = new Parent({
        name: "a",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const b = new Parent({
        name: "b",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      a[referenceSymbol](doc);
      b[referenceSymbol](doc);

      a.children.push(b);
      b.childSet.add(a);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const aParentRef = models.get(a.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      const bParentRef = models.get(b.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);

      expect(aParentRef).toEqual([b.uuid, `childSet`]);
      expect(bParentRef).toEqual([a.uuid, `children`]);
    });
  });

  describe("Field names with dots", () => {
    it("handles field names containing dots correctly", () => {
      type WeirdParent = ModelType<
        {
          "field.with.dots": Child | null;
        },
        "WeirdParent"
      >;

      const WeirdParent = buildModelClass<WeirdParent>("WeirdParent", {
        "field.with.dots": "child-val"
      });

      const parent = new WeirdParent({ "field.with.dots": null });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent["field.with.dots"] = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      // Parent ref should preserve dots in field name
      expect(parentRef).toEqual([parent.uuid, `field.with.dots`]);
    });
  });

  describe("Ephemeral to materialized transitions", () => {
    it("preserves parent tracking through materialization", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      // Set up parent-child relationship while ephemeral
      parent.child = child;

      // Materialize parent (child materializes via contagion)
      parent[referenceSymbol](doc);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([parent.uuid, `child`]);
    });

    it("handles ephemeral child added to materialized parent", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      parent[referenceSymbol](doc); // Materialize parent first

      const child = new Child({ name: "child" }); // Ephemeral child
      parent.children.push(child); // Should trigger contagion

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid!);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([parent.uuid, `children`]);
    });
  });

  describe("Clone operations", () => {
    it("cloned parent gets new children with correct parent refs", () => {
      const original = new Parent({
        name: "original",
        child: new Child({ name: "originalChild" }),
        children: [new Child({ name: "child1" }), new Child({ name: "child2" })],
        childSet: new Set([new Child({ name: "setChild" })]),
        childMap: { key: new Child({ name: "mapChild" }) }
      });

      original[referenceSymbol](doc);

      const cloned = original.clone();
      cloned[referenceSymbol](doc);

      // Cloned should have different children instances
      expect(cloned.child).not.toBe(original.child);
      expect(cloned.children[0]).not.toBe(original.children[0]);
      cloned.name = 'cloned'
      cloned.child.name = 'cloned child'
      cloned.children[0].name = 'cloned child1'
      cloned.children[1].name = 'cloned child2'

      // Check parent refs point to cloned parent
      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);

      const clonedChildRef = models.get(cloned.child!.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(clonedChildRef).toEqual([cloned.uuid, `child`]);

      const clonedListChildRef = models.get(cloned.children[0].uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(clonedListChildRef).toEqual([cloned.uuid, `children`]);

      // Original children should still point to original parent
      const originalChildRef = models.get(original.child!.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(originalChildRef).toEqual([original.uuid, `child`]);
    });
  });

  describe("Collection operations", () => {
    it("updates parent refs on splice", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });
      const child3 = new Child({ name: "child3" });

      parent[referenceSymbol](doc);
      parent.children.push(child1, child2);

      // Splice in child3, removing child1
      parent.children.splice(0, 1, child3);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);

      // child1 should have no parent
      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();

      // child3 should have parent ref
      expect(models.get(child3.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `children`]);

      // child2 should still have parent ref
      expect(models.get(child2.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `children`]);
    });

    it("clears parent ref on pop/shift", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      parent[referenceSymbol](doc);
      parent.children.push(child1, child2);

      const popped = parent.children.pop();
      expect(popped).toBe(child2);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child2.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `children`]);

      const shifted = parent.children.shift();
      expect(shifted).toBe(child1);
      expect(models.get(child1.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("updates parent refs on set delete", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.childSet.add(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `childSet`]);

      parent.childSet.delete(child);
      expect(models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("updates parent refs on record delete", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.childMap["key"] = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `childMap`, `key`]);

      delete parent.childMap["key"];
      expect(models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });
  });

  describe("Multiple parent fields", () => {
    it("correctly tracks when moving between fields of same parent", () => {
      const parent = new MultiParent({
        name: "parent",
        leftChildren: [],
        rightChildren: []
      });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);

      parent.leftChildren.push(child);
      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `leftChildren`]);

      parent.rightChildren.push(child);
      expect(parent.leftChildren).not.toContain(child);
      expect(parent.rightChildren).toContain(child);
      expect(models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([parent.uuid, `rightChildren`]);
    });
  });

  describe("Dependency entities", () => {
    it("doesn't set parent refs on read-only dependency entities", () => {
      // Create dependency doc with a child
      const depDoc = new Y.Doc();
      primeDoc(depDoc);
      const depChild = new Child({ name: "depChild" });
      depChild[referenceSymbol](depDoc);

      // Create root doc with parent
      const rootDoc = new Y.Doc();
      primeDoc(rootDoc);
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      parent[referenceSymbol](rootDoc);
      storeAsRoot(rootDoc, parent);

      // Load with dependency
      const loadedParent = load<Parent>(rootDoc, { dep: depDoc });

      // This should fail or be ignored - can't modify dependency entity
      expect(() => {
        loadedParent.child = depChild; // Trying to set dependency entity as child
      }).toThrow(); // Or might silently fail depending on implementation
    });
  });

  describe("Transaction boundaries", () => {
    it("handles multiple parent changes in single transaction correctly", () => {
      const parent1 = new Parent({
        name: "parent1",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const parent2 = new Parent({
        name: "parent2",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      parent1[referenceSymbol](doc);
      parent2[referenceSymbol](doc);

      doc.transact(() => {
        parent1.children.push(child); // First parent assignment
        parent2.childSet.add(child); // Second parent assignment (should remove from first)
        parent1.child = child; // Third parent assignment (should remove from second)
      });

      // After transaction, child should only be in parent1.child
      expect(parent1.child).toBe(child);
      expect(parent1.children).not.toContain(child);
      expect(parent2.childSet.has(child)).toBe(false);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(parentRef).toEqual([parent1.uuid, `child`]);
    });
  });

  describe("Edge case: primitives in child collections", () => {
    it("ignores primitive values when tracking parents", () => {
      type Mixed = ModelType<
        {
          readonly mixed: (Child | string)[];
        },
        "Mixed"
      >;

      const Mixed = buildModelClass<Mixed>("Mixed", {
        mixed: "child-list"
      });

      const parent = new Mixed({ mixed: [] });
      const child = new Child({ name: "child" });

      parent[referenceSymbol](doc);
      parent.mixed.push("string", child, "another");

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(child.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);

      // Only the Child entity should have parent ref
      expect(parentRef).toEqual([parent.uuid, `mixed`]);
      expect(parent.mixed).toEqual(["string", child, "another"]);
    });
  });

  describe("Performance edge case", () => {
    it("efficiently handles large collections", () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      parent[referenceSymbol](doc);

      // Add many children
      const children: Child[] = [];
      for (let i = 0; i < 1000; i++) {
        children.push(new Child({ name: `child${i}` }));
      }

      parent.children.push(...children);

      // Move first child to end
      const first = children[0];
      parent.children.push(first);

      // Should be removed from beginning and added to end
      expect(parent.children.indexOf(first)).toBe(999);
      expect(parent.children.filter((c) => c === first).length).toBe(1);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(first.uuid!)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(parentRef).toEqual([parent.uuid, `children`]);
    });
  });
});
