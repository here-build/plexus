import { describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { referenceSymbol } from "../proxy-runtime-types";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { initTestPlexus } from "./test-plexus";
import * as Y from "yjs";

// Test models with various child-* field configurations
@syncing
class Child extends PlexusModel {
  @syncing
  accessor name!: string;

  constructor(props) {
    super(props);
  }
}

@syncing
class Parent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor child!: Child | null;

  @syncing.child.list
  accessor children!: Child[];

  @syncing.child.set
  accessor childSet!: Set<Child>;

  @syncing.child.map
  accessor childMap!: Record<string, Child>;

  constructor(props) {
    super(props);
  }
}

@syncing
class MultiParent extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child.list
  accessor leftChildren!: Child[];

  @syncing.child.list
  accessor rightChildren!: Child[];

  constructor(props) {
    super(props);
  }
}

describe("Parent Tracking", () => {
  describe("Basic parent assignment", () => {
    it("tracks parent when child assigned to child-val field", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.child = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);
      console.log("Child UUID:", child.uuid);
      console.log("Parent UUID:", materializedParent.uuid);
      console.log("Child fields:", childFields);
      console.log("Child fields entries:", childFields ? Array.from(childFields.entries()) : "none");
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);
      console.log("Parent ref:", parentRef);

      expect(parentRef).toEqual([materializedParent.uuid, `child`]);
    });

    it("tracks parent when child added to child-list", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.children.push(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);

      expect(models.get(child.uuid)!.toJSON()).toMatchObject({
        [YJS_GLOBALS.modelMetadataParent]: [materializedParent.uuid, "children"]
      });
    });

    it("tracks parent when child added to child-set", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.childSet.add(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([materializedParent.uuid, "childSet"]);
    });

    it("tracks parent when child added to child-record", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.childMap["key1"] = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);

      expect(childFields?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([materializedParent.uuid, "childMap", "key1"]);
    });
  });

  describe("Reparenting", () => {
    it("removes from old parent when assigned to new parent", async () => {
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

      // For cross-parent operations, we need to materialize both parents in the same document
      const { doc, plexus } = await initTestPlexus<Parent>(parent1);
      const materializedParent1 = await plexus.rootPromise;

      // Materialize the second parent in the same document
      const [parent2Id] = (parent2 as any)[referenceSymbol](doc);
      const materializedParent2 = plexus.loadEntity<Parent>(parent2Id)!;

      // First assignment
      materializedParent1.children.push(child);
      expect(materializedParent1.children).toContain(child);

      // Reparent - this should work now as they're in the same doc context
      materializedParent2.child = child;

      // Should be removed from parent1.children
      expect(materializedParent1.children).not.toContain(child);
      expect(materializedParent2.child).toBe(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([materializedParent2.uuid, `child`]);
    });

    it("handles moving between different collection types", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);

      // list → set
      materializedParent.children.push(child);
      expect(materializedParent.children).toContain(child);

      materializedParent.childSet.add(child);
      expect(materializedParent.children).not.toContain(child);
      expect(materializedParent.childSet.has(child)).toBe(true);

      // set → record
      materializedParent.childMap["key"] = child;
      expect(materializedParent.childSet.has(child)).toBe(false);
      expect(materializedParent.childMap["key"]).toBe(child);

      // record → val
      materializedParent.child = child;
      expect(materializedParent.childMap["key"]).toBeUndefined();
      expect(materializedParent.child).toBe(child);
    });

    it("handles moving within same list", async () => {
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

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);

      materializedParent.children.push(other1, child, other2);
      expect(materializedParent.children.indexOf(child)).toBe(1);

      // Move to end by pushing again
      materializedParent.children.push(child);
      expect(materializedParent.children.indexOf(child)).toBe(2); // Should be at end now
      expect(materializedParent.children.filter((c) => c === child).length).toBe(1); // Only one instance
    });

    it("handles moving between record keys", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);

      materializedParent.childMap["key1"] = child;
      expect(materializedParent.childMap["key1"]).toBe(child);

      materializedParent.childMap["key2"] = child;
      expect(materializedParent.childMap["key1"]).toBeUndefined();
      expect(materializedParent.childMap["key2"]).toBe(child);
    });
  });

  describe("Null and clear operations", () => {
    it("clears parent ref when child-val set to null", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.child = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      let childFields = models.get(child.uuid);
      expect(childFields?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();

      materializedParent.child = null;
      childFields = models.get(child.uuid);
      expect(childFields?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("clears parent refs when list cleared", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.children.push(child1, child2);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();
      expect(models.get(child2.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();

      materializedParent.children.clear();

      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
      expect(models.get(child2.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("clears parent refs when record reassigned", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.childMap["a"] = child1;
      materializedParent.childMap["b"] = child2;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();
      expect(models.get(child2.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeDefined();

      materializedParent.childMap.assign({});

      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
      expect(models.get(child2.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });
  });

  describe("Cycles", () => {
    it("handles direct cycle (A.child = B, B.child = A)", async () => {
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

      // For cross-parent operations, both entities need to be in the same document
      const { doc, plexus } = await initTestPlexus<Parent>(a);
      const materializedA = await plexus.rootPromise;

      // Materialize B in the same document
      const [bId] = b[referenceSymbol](doc);
      const materializedB = plexus.loadEntity<Parent>(bId)!;

      materializedA.child = materializedB;
      materializedB.child = materializedA;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const aParentRef = models.get(materializedA.uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      const bParentRef = models.get(materializedB.uuid)?.get(YJS_GLOBALS.modelMetadataParent);

      expect(aParentRef).toEqual([materializedB.uuid, `child`]);
      expect(bParentRef).toEqual([materializedA.uuid, `child`]);
    });

    it("handles self-reference", async () => {
      const self = new Parent({
        name: "self",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      const { doc, root: materializedSelf } = await initTestPlexus<Parent>(self);
      materializedSelf.child = materializedSelf;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(materializedSelf.uuid)?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([materializedSelf.uuid, `child`]);
    });

    it("handles cycle through collections", async () => {
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

      // For cross-parent operations, both entities need to be in the same document
      const { doc, plexus } = await initTestPlexus<Parent>(a);
      const materializedA = await plexus.rootPromise;

      // Materialize B in the same document
      const [bId] = (b as any)[referenceSymbol](doc);
      const materializedB = plexus.loadEntity<Parent>(bId)!;

      materializedA.children.push(materializedB);
      materializedB.childSet.add(materializedA);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const aParentRef = models.get(materializedA.uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      const bParentRef = models.get(materializedB.uuid)?.get(YJS_GLOBALS.modelMetadataParent);

      expect(aParentRef).toEqual([materializedB.uuid, `childSet`]);
      expect(bParentRef).toEqual([materializedA.uuid, `children`]);
    });
  });

  describe("Field names with dots", () => {
    it("handles field names containing dots correctly", async () => {
      @syncing
      class WeirdParent extends PlexusModel {
        @syncing.child
        accessor "field.with.dots"!: Child | null;

        constructor(props) {
          super(props);
        }
      }

      const parent = new WeirdParent({ "field.with.dots": null });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<WeirdParent>(parent);
      materializedParent["field.with.dots"] = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      // Parent ref should preserve dots in field name
      expect(parentRef).toEqual([materializedParent.uuid, `field.with.dots`]);
    });
  });

  describe("Ephemeral to materialized transitions", () => {
    it("preserves parent tracking through materialization", async () => {
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
      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([materializedParent.uuid, `child`]);
    });

    it("handles ephemeral child added to materialized parent", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent); // Materialize parent first

      const child = new Child({ name: "child" }); // Ephemeral child
      materializedParent.children.push(child); // Should trigger contagion

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const childFields = models.get(child.uuid);
      const parentRef = childFields?.get(YJS_GLOBALS.modelMetadataParent);

      expect(parentRef).toEqual([materializedParent.uuid, `children`]);
    });
  });

  describe("Clone operations", () => {
    it("cloned parent gets new children with correct parent refs", async () => {
      const original = new Parent({
        name: "original",
        child: new Child({ name: "originalChild" }),
        children: [new Child({ name: "child1" }), new Child({ name: "child2" })],
        childSet: new Set([new Child({ name: "setChild" })]),
        childMap: { key: new Child({ name: "mapChild" }) }
      });

      const { doc, root: materializedOriginal, plexus } = await initTestPlexus<Parent>(original);

      const cloned = materializedOriginal.clone();
      // Materialize the cloned entity in the same document
      const [clonedId] = (cloned as any)[referenceSymbol](doc);
      const materializedCloned = plexus.loadEntity<Parent>(clonedId)!;

      // Cloned should have different children instances
      expect(materializedCloned.child).not.toBe(materializedOriginal.child);
      expect(materializedCloned.children[0]).not.toBe(materializedOriginal.children[0]);
      materializedCloned.name = "cloned";
      materializedCloned.child!.name = "cloned child";
      materializedCloned.children[0].name = "cloned child1";
      materializedCloned.children[1].name = "cloned child2";

      // Check parent refs point to cloned parent
      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);

      const clonedChildRef = models.get(materializedCloned.child!.uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(clonedChildRef).toEqual([materializedCloned.uuid, `child`]);

      const clonedListChildRef = models.get(materializedCloned.children[0].uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(clonedListChildRef).toEqual([materializedCloned.uuid, `children`]);

      // Original children should still point to original parent
      const originalChildRef = models.get(materializedOriginal.child!.uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(originalChildRef).toEqual([materializedOriginal.uuid, `child`]);
    });
  });

  describe("Collection operations", () => {
    it("updates parent refs on splice", async () => {
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

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.children.push(child1, child2);

      // Splice in child3, removing child1
      materializedParent.children.splice(0, 1, child3);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);

      // child1 should have no parent
      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();

      // child3 should have parent ref
      expect(models.get(child3.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `children`
      ]);

      // child2 should still have parent ref
      expect(models.get(child2.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `children`
      ]);
    });

    it("clears parent ref on pop/shift", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child1 = new Child({ name: "child1" });
      const child2 = new Child({ name: "child2" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.children.push(child1, child2);

      const popped = materializedParent.children.pop();
      expect(popped).toBe(child2);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child2.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `children`
      ]);

      const shifted = materializedParent.children.shift();
      expect(shifted).toBe(child1);
      expect(models.get(child1.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("updates parent refs on set delete", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.childSet.add(child);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `childSet`
      ]);

      materializedParent.childSet.delete(child);
      expect(models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });

    it("updates parent refs on record delete", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);
      materializedParent.childMap["key"] = child;

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `childMap`,
        `key`
      ]);

      delete materializedParent.childMap["key"];
      expect(models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toBeUndefined();
    });
  });

  describe("Multiple parent fields", () => {
    it("correctly tracks when moving between fields of same parent", async () => {
      const parent = new MultiParent({
        name: "parent",
        leftChildren: [],
        rightChildren: []
      });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<MultiParent>(parent);

      materializedParent.leftChildren.push(child);
      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      expect(models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `leftChildren`
      ]);

      materializedParent.rightChildren.push(child);
      expect(materializedParent.leftChildren).not.toContain(child);
      expect(materializedParent.rightChildren).toContain(child);
      expect(models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent)).toEqual([
        materializedParent.uuid,
        `rightChildren`
      ]);
    });
  });

  describe("Dependency entities", () => {
    it("can't directly assign entities from different docs", async () => {
      // Create dependency doc with a child
      const depChild = new Child({ name: "depChild" });
      const { doc: depDoc } = await initTestPlexus<Child>(depChild);

      // Create root doc with parent
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });
      const { plexus, root: materializedParent } = await initTestPlexus<Parent>(parent);

      // Set up dependency factory
      plexus.registerDependencyFactory("dep", async () => depDoc);

      // This should fail - can't assign entity from different doc directly
      expect(() => {
        materializedParent.child = depChild; // Trying to set dependency entity as child
      }).toThrow(); // Or might silently fail depending on implementation
    });
  });

  describe("Transaction boundaries", () => {
    it("handles multiple parent changes in single transaction correctly", async () => {
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

      // For cross-parent operations, both entities need to be in the same document
      const { doc, plexus } = await initTestPlexus<Parent>(parent1);
      const materializedParent1 = await plexus.rootPromise;

      // Materialize parent2 in the same document
      const [parent2Id] = (parent2 as any)[referenceSymbol](doc);
      const materializedParent2 = plexus.loadEntity<Parent>(parent2Id) as Parent;

      doc.transact(() => {
        materializedParent1.children.push(child); // First parent assignment
        materializedParent2.childSet.add(child); // Second parent assignment (should remove from first)
        materializedParent1.child = child; // Third parent assignment (should remove from second)
      });

      // After transaction, child should only be in parent1.child
      expect(materializedParent1.child).toBe(child);
      expect(materializedParent1.children).not.toContain(child);
      expect(materializedParent2.childSet.has(child)).toBe(false);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(parentRef).toEqual([materializedParent1.uuid, `child`]);
    });
  });

  describe("Edge case: primitives in child collections", () => {
    it("ignores primitive values when tracking parents", async () => {
      @syncing
      class Mixed extends PlexusModel {
        @syncing.child.list
        accessor mixed!: (Child | string)[];

        constructor(props) {
          super(props);
        }
      }

      const parent = new Mixed({ mixed: [] });
      const child = new Child({ name: "child" });

      const { doc, root: materializedParent } = await initTestPlexus<Mixed>(parent);
      materializedParent.mixed.push("string", child, "another");

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(child.uuid)?.get(YJS_GLOBALS.modelMetadataParent);

      // Only the Child entity should have parent ref
      expect(parentRef).toEqual([materializedParent.uuid, `mixed`]);
      expect(materializedParent.mixed).toEqual(["string", child, "another"]);
    });
  });

  describe("Performance edge case", () => {
    it("efficiently handles large collections", async () => {
      const parent = new Parent({
        name: "parent",
        child: null,
        children: [],
        childSet: new Set(),
        childMap: {}
      });

      const { doc, root: materializedParent } = await initTestPlexus<Parent>(parent);

      // Add many children
      const children: Child[] = [];
      for (let i = 0; i < 1000; i++) {
        children.push(new Child({ name: `child${i}` }));
      }

      materializedParent.children.push(...children);

      // Move first child to end
      const first = children[0];
      materializedParent.children.push(first);

      // Should be removed from beginning and added to end
      expect(materializedParent.children.indexOf(first)).toBe(999);
      expect(materializedParent.children.filter((c) => c === first).length).toBe(1);

      const models = doc.getMap<Y.Map<any>>(YJS_GLOBALS.models);
      const parentRef = models.get(first.uuid)?.get(YJS_GLOBALS.modelMetadataParent);
      expect(parentRef).toEqual([materializedParent.uuid, `children`]);
    });
  });
});
