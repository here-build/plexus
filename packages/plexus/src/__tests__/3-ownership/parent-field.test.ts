/**
 * parentField / parentFieldKey Tests
 *
 * Tests the public getters that expose which field on the parent
 * owns this entity, and (for keyed containers) the key within that field.
 *
 * - parentField: field name on parent (e.g. "children", "child")
 * - parentFieldKey: extra key (record key, serialized map key), null for non-keyed
 */

import { describe, expect, it } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ── Leaf model ──

@syncing
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

// ── Container models (one field type each for clarity) ──

@syncing
class ChildValOwner extends PlexusModel {
  @syncing.child accessor child: Item | null = null;
}

@syncing
class ChildListOwner extends PlexusModel {
  @syncing.child.list accessor children: Item[] = [];
}

@syncing
class ChildSetOwner extends PlexusModel {
  @syncing.child.set accessor tags: Set<Item> = new Set();
}

@syncing
class ChildRecordOwner extends PlexusModel {
  @syncing.child.record accessor items: Record<string, Item> = {};
}

@syncing
class ChildMapOwner extends PlexusModel {
  @syncing.child.map accessor entries!: Map<string, Item>;
}

// ── Multi-field parent for reparenting tests ──

@syncing
class MultiFieldParent extends PlexusModel {
  @syncing.child accessor single: Item | null = null;
  @syncing.child.list accessor listA: Item[] = [];
  @syncing.child.list accessor listB: Item[] = [];
  @syncing.child.record accessor rec: Record<string, Item> = {};
}

// ── Root ──

@syncing
class Root extends PlexusModel<null> {
  @syncing.child.list accessor childVals: ChildValOwner[] = [];
  @syncing.child.list accessor childLists: ChildListOwner[] = [];
  @syncing.child.list accessor childSets: ChildSetOwner[] = [];
  @syncing.child.list accessor childRecords: ChildRecordOwner[] = [];
  @syncing.child.list accessor childMaps: ChildMapOwner[] = [];
  @syncing.child.list accessor multis: MultiFieldParent[] = [];
}

// ── Tests ──

describe("parentField / parentFieldKey", () => {
  describe("child-val", () => {
    it("reports field name, null key", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildValOwner();
      root.childVals.push(owner);

      const item = new Item({ name: "a" });
      owner.child = item;

      expect(item.parentField).toBe("child");
      expect(item.parentFieldKey).toBeNull();
    });
  });

  describe("child-list", () => {
    it("reports field name, null key", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildListOwner();
      root.childLists.push(owner);

      const item = new Item({ name: "a" });
      owner.children.push(item);

      expect(item.parentField).toBe("children");
      expect(item.parentFieldKey).toBeNull();
    });

    it("all elements share the same field name", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildListOwner();
      root.childLists.push(owner);

      const a = new Item({ name: "a" });
      const b = new Item({ name: "b" });
      owner.children.push(a, b);

      expect(a.parentField).toBe("children");
      expect(b.parentField).toBe("children");
      expect(a.parentFieldKey).toBeNull();
      expect(b.parentFieldKey).toBeNull();
    });
  });

  describe("child-set", () => {
    it("reports field name, null key", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildSetOwner();
      root.childSets.push(owner);

      const item = new Item({ name: "a" });
      owner.tags.add(item);

      expect(item.parentField).toBe("tags");
      expect(item.parentFieldKey).toBeNull();
    });
  });

  describe("child-record", () => {
    it("reports field name and record key", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildRecordOwner();
      root.childRecords.push(owner);

      const item = new Item({ name: "a" });
      owner.items["foo"] = item;

      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("foo");
    });

    it("different keys for different entries", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildRecordOwner();
      root.childRecords.push(owner);

      const a = new Item({ name: "a" });
      const b = new Item({ name: "b" });
      owner.items["alpha"] = a;
      owner.items["beta"] = b;

      expect(a.parentField).toBe("items");
      expect(a.parentFieldKey).toBe("alpha");
      expect(b.parentField).toBe("items");
      expect(b.parentFieldKey).toBe("beta");
    });
  });

  describe("child-map", () => {
    it("reports field name and deserialized key", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildMapOwner();
      root.childMaps.push(owner);

      const item = new Item({ name: "a" });
      owner.entries.set("foo", item);

      expect(item.parentField).toBe("entries");
      expect(item.parentFieldKey).toBe("foo");
    });

    it("different keys for different entries", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildMapOwner();
      root.childMaps.push(owner);

      const a = new Item({ name: "a" });
      const b = new Item({ name: "b" });
      owner.entries.set("x", a);
      owner.entries.set("y", b);

      expect(a.parentFieldKey).toBe("x");
      expect(b.parentFieldKey).toBe("y");
    });
  });

  describe("child-map with Array<PlexusModel> key", () => {
    @syncing
    class ArrayKeyMapOwner extends PlexusModel {
      @syncing.child.map accessor entries!: Map<Item[], Item>;
      @syncing.child.list accessor children: Item[] = [];
    }

    @syncing
    class ArrayKeyRoot extends PlexusModel<null> {
      @syncing.child.list accessor owners: ArrayKeyMapOwner[] = [];
    }

    it("returns deserialized array key with entity references", () => {
      const keyA = new Item({ name: "kA" });
      const keyB = new Item({ name: "kB" });
      const value = new Item({ name: "val" });
      const owner = new ArrayKeyMapOwner({
        entries: new Map([[[keyA, keyB], value]]),
        children: [keyA, keyB],
      });
      const { root } = initTestPlexus(new ArrayKeyRoot());
      root.owners.push(owner);

      expect(value.parentField).toBe("entries");
      const key = value.parentFieldKey;
      expect(Array.isArray(key)).toBe(true);
      const arr = key as unknown[];
      expect(arr).toHaveLength(2);
      expect(arr).toContain(keyA);
      expect(arr).toContain(keyB);
    });

    it("different array keys produce different parentFieldKeys", () => {
      const k1 = new Item({ name: "k1" });
      const k2 = new Item({ name: "k2" });
      const v1 = new Item({ name: "v1" });
      const v2 = new Item({ name: "v2" });
      const owner = new ArrayKeyMapOwner({
        entries: new Map([
          [[k1], v1],
          [[k2], v2],
        ]),
        children: [k1, k2],
      });
      const { root } = initTestPlexus(new ArrayKeyRoot());
      root.owners.push(owner);

      const key1 = v1.parentFieldKey as unknown[];
      const key2 = v2.parentFieldKey as unknown[];
      expect(key1).toHaveLength(1);
      expect(key2).toHaveLength(1);
      expect(key1[0]).toBe(k1);
      expect(key2[0]).toBe(k2);
    });
  });

  describe("child-map with Set<PlexusModel> key", () => {
    @syncing
    class SetKeyMapOwner extends PlexusModel {
      @syncing.child.map accessor entries!: Map<Set<Item>, Item>;
      @syncing.child.list accessor children: Item[] = [];
    }

    @syncing
    class SetKeyRoot extends PlexusModel<null> {
      @syncing.child.list accessor owners: SetKeyMapOwner[] = [];
    }

    it("returns deserialized Set key with entity references", () => {
      const keyA = new Item({ name: "kA" });
      const keyB = new Item({ name: "kB" });
      const value = new Item({ name: "val" });
      const owner = new SetKeyMapOwner({
        entries: new Map([[new Set([keyA, keyB]), value]]),
        children: [keyA, keyB],
      });
      const { root } = initTestPlexus(new SetKeyRoot());
      root.owners.push(owner);

      expect(value.parentField).toBe("entries");
      const key = value.parentFieldKey;
      expect(key).toBeInstanceOf(Set);
      const set = key as Set<unknown>;
      expect(set.size).toBe(2);
      expect(set.has(keyA)).toBe(true);
      expect(set.has(keyB)).toBe(true);
    });

    it("set keys with different elements produce different parentFieldKeys", () => {
      const k1 = new Item({ name: "k1" });
      const k2 = new Item({ name: "k2" });
      const v1 = new Item({ name: "v1" });
      const v2 = new Item({ name: "v2" });
      const owner = new SetKeyMapOwner({
        entries: new Map([
          [new Set([k1]), v1],
          [new Set([k2]), v2],
        ]),
        children: [k1, k2],
      });
      const { root } = initTestPlexus(new SetKeyRoot());
      root.owners.push(owner);

      const set1 = v1.parentFieldKey as Set<unknown>;
      const set2 = v2.parentFieldKey as Set<unknown>;
      expect(set1.has(k1)).toBe(true);
      expect(set2.has(k2)).toBe(true);
      expect(set1.has(k2)).toBe(false);
      expect(set2.has(k1)).toBe(false);
    });

    it("set key contains correct entity references regardless of insertion order", () => {
      const k1 = new Item({ name: "k1" });
      const k2 = new Item({ name: "k2" });
      const value = new Item({ name: "val" });
      const owner = new SetKeyMapOwner({
        entries: new Map([[new Set([k1, k2]), value]]),
        children: [k1, k2],
      });
      const { root } = initTestPlexus(new SetKeyRoot());
      root.owners.push(owner);

      const set = value.parentFieldKey as Set<unknown>;
      expect(set.size).toBe(2);
      expect(set.has(k1)).toBe(true);
      expect(set.has(k2)).toBe(true);
    });
  });

  describe("root entity", () => {
    it("has null parentField, null parentFieldKey, null parent", () => {
      const { root } = initTestPlexus(new Root());

      expect(root.parent).toBeNull();
      expect(root.parentField).toBeNull();
      expect(root.parentFieldKey).toBeNull();
    });
  });

  describe("virtual (unmaterialized) entity", () => {
    it("has null parentField and parentFieldKey", () => {
      const item = new Item({ name: "ephemeral" });

      expect(item.parentField).toBeNull();
      expect(item.parentFieldKey).toBeNull();
    });
  });

  describe("after reparenting", () => {
    it("updates parentField when moved between different field types", () => {
      const { root } = initTestPlexus(new Root());
      const parent = new MultiFieldParent();
      root.multis.push(parent);

      const item = new Item({ name: "nomad" });

      // Start in child-val
      parent.single = item;
      expect(item.parentField).toBe("single");
      expect(item.parentFieldKey).toBeNull();

      // Move to child-list
      parent.listA.push(item);
      expect(item.parentField).toBe("listA");
      expect(item.parentFieldKey).toBeNull();
      expect(parent.single).toBeNull(); // auto-orphaned from previous field

      // Move to another child-list
      parent.listB.push(item);
      expect(item.parentField).toBe("listB");
      expect(item.parentFieldKey).toBeNull();

      // Move to child-record
      parent.rec["key1"] = item;
      expect(item.parentField).toBe("rec");
      expect(item.parentFieldKey).toBe("key1");
    });

    it("updates parentFieldKey when moved between record keys", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildRecordOwner();
      root.childRecords.push(owner);

      const item = new Item({ name: "a" });
      owner.items["first"] = item;

      expect(item.parentFieldKey).toBe("first");

      // Re-assign to a different key on the same record
      owner.items["second"] = item;

      expect(item.parentField).toBe("items");
      expect(item.parentFieldKey).toBe("second");
    });

    it("clears parentField after detach", () => {
      const { root } = initTestPlexus(new Root());
      const owner = new ChildValOwner();
      root.childVals.push(owner);

      const item = new Item({ name: "a" });
      owner.child = item;

      expect(item.parentField).toBe("child");

      item.detach();

      expect(item.parent).toBeNull();
      expect(item.parentField).toBeNull();
      expect(item.parentFieldKey).toBeNull();
    });
  });
});
