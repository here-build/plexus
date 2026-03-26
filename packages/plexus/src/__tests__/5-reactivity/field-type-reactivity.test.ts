/**
 * Systematic reactivity tests for all field type combinations
 *
 * Tests verify:
 * - All field types correctly trigger reactivity when mutated
 * - Ephemeral vs materialized state behavior
 * - Child entity mutations trigger watchers of the child
 * - Cross-entity references work correctly
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { createTrackedFunction } from "../../tracking.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ============================================
// Test Models
// ============================================

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor count: number = 0;
}

@syncing("Container")
class Container extends PlexusModel<null> {
  // Non-child fields
  @syncing accessor val: string = "";
  @syncing accessor valNum: number = 0;
  @syncing accessor valRef: Item | null = null;
  @syncing.list accessor list: string[] = [];
  @syncing.set accessor set: Set<string> = new Set();
  @syncing.record accessor record: Record<string, string> = {};
  @syncing.map accessor map!: Map<string, string>;

  // Child fields
  @syncing.child accessor childVal: Item | null = null;
  @syncing.child.list accessor childList: Item[] = [];
  @syncing.child.set accessor childSet: Set<Item> = new Set();
  @syncing.child.record accessor childRecord: Record<string, Item> = {};
}

// ============================================
// EPHEMERAL state reactivity tests
// ============================================

describe("Ephemeral State Reactivity", () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  describe("primitive val fields", () => {
    it("notifies when accessed val is modified", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.val);

      tracked();
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

      container.val = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("does NOT notify when non-accessed val is modified", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.val);

      tracked();
      container.valNum = 42; // Different field
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
    });
  });

  describe("list fields", () => {
    it("notifies when list.push() is called", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.list.length);

      tracked();
      container.list.push("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when list element is modified", () => {
      container.list.push("initial");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.list[0]);

      tracked();
      container.list[0] = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies on list iteration after push", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...container.list]);

      tracked();
      container.list.push("new");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("set fields", () => {
    it("notifies when set.add() is called (tracking via iteration)", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...container.set]);

      tracked();
      container.set.add("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when set.delete() is called (tracking via iteration)", () => {
      container.set.add("item");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...container.set]);

      tracked();
      container.set.delete("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("record fields", () => {
    it("notifies when record key is assigned", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.record["key"]);

      tracked();
      container.record["key"] = "value";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when record key is deleted", () => {
      container.record["key"] = "value";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.keys(container.record));

      tracked();
      delete container.record["key"];
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("field isolation (ephemeral)", () => {
    it("modifying list does NOT notify val watcher", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.val);

      tracked();
      container.list.push("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
    });

    it("modifying record does NOT notify set watcher", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.set.size);

      tracked();
      container.record["key"] = "value";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
    });
  });
});

// ============================================
// MATERIALIZED state reactivity tests
// ============================================

describe("Materialized State Reactivity", () => {
  let container: Container;

  beforeEach(() => {
    const result = initTestPlexus(new Container());
    container = result.root;
  });

  describe("primitive val fields", () => {
    it("notifies when accessed val is modified", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.val);

      tracked();
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

      container.val = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("list fields", () => {
    it("notifies when list.push() is called", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.list.length);

      tracked();
      container.list.push("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when list element is modified", () => {
      container.list.push("initial");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.list[0]);

      tracked();
      container.list[0] = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies on pop", () => {
      container.list.push("a", "b");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.list.length);

      tracked();
      container.list.pop();
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies on splice", () => {
      container.list.push("a", "b", "c");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.list.length);

      tracked();
      container.list.splice(1, 1);
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("set fields", () => {
    it("notifies when set.add() is called (tracking via iteration)", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...container.set]);

      tracked();
      container.set.add("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when set.delete() is called (tracking via iteration)", () => {
      container.set.add("item");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...container.set]);

      tracked();
      container.set.delete("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when set.add() is called (tracking via has)", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.set.has("item"));

      tracked();
      container.set.add("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when set.add() is called (tracking via size)", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.set.size);

      tracked();
      expect(container.set.size).to.equal(0);
      container.set.add("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when set.delete() is called (tracking via size)", () => {
      container.set.add("item");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.set.size);

      tracked();
      expect(container.set.size).to.equal(1);
      container.set.delete("item");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("record fields", () => {
    it("notifies when record key is assigned", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.record["key"]);

      tracked();
      container.record["key"] = "value";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when record key is deleted", () => {
      container.record["key"] = "value";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.keys(container.record));

      tracked();
      delete container.record["key"];
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("map fields", () => {
    it("notifies when map.set() is called", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.map.get("key"));

      tracked();
      container.map.set("key", "value");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when map.delete() is called", () => {
      container.map.set("key", "value");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.map.size);

      tracked();
      container.map.delete("key");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies on map keys iteration", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...container.map.keys()]);

      tracked();
      container.map.set("newKey", "value");
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });
});

// ============================================
// Child field reactivity tests
// ============================================

describe("Child Field Reactivity", () => {
  let container: Container;

  beforeEach(() => {
    const result = initTestPlexus(new Container());
    container = result.root;
  });

  describe("child-val", () => {
    it("notifies when child is assigned", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childVal);

      tracked();
      container.childVal = new Item({ name: "new" });
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when child property is modified", () => {
      container.childVal = new Item({ name: "initial" });

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childVal?.name);

      tracked();
      container.childVal!.name = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("child-list", () => {
    it("notifies when child is added", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childList.length);

      tracked();
      container.childList.push(new Item({ name: "new" }));
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when child entity property is modified", () => {
      const item = new Item({ name: "initial" });
      container.childList.push(item);

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childList[0]?.name);

      tracked();
      container.childList[0].name = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when child is removed", () => {
      container.childList.push(new Item({ name: "a" }));

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childList.length);

      tracked();
      container.childList.pop();
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("child-set", () => {
    it("notifies when child is added (tracking via iteration)", () => {
      const notify = vi.fn();
      // Note: must use iteration, not .size, because .size doesn't track access
      const tracked = createTrackedFunction(notify, () => [...container.childSet]);

      tracked();
      container.childSet.add(new Item({ name: "new" }));
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when child entity property is modified", () => {
      container.childSet.add(new Item({ name: "initial" }));

      const notify = vi.fn();
      // Access through the container to get the materialized version
      const tracked = createTrackedFunction(notify, () => [...container.childSet][0]?.name);

      tracked();
      // Modify through the container's reference to trigger reactivity
      [...container.childSet][0].name = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("child-record", () => {
    it("notifies when child is assigned", () => {
      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childRecord["key"]);

      tracked();
      container.childRecord["key"] = new Item({ name: "new" });
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when child entity property is modified", () => {
      container.childRecord["key"] = new Item({ name: "initial" });

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => container.childRecord["key"]?.name);

      tracked();
      container.childRecord["key"].name = "changed";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });
});

// ============================================
// Cross-entity reactivity
// ============================================

describe("Cross-Entity Reactivity", () => {
  let container: Container;

  beforeEach(() => {
    const result = initTestPlexus(new Container());
    container = result.root;
  });

  it("modifying child entity notifies watcher of that child", () => {
    // Assign a child entity
    container.childVal = new Item({ name: "original" });

    const notify = vi.fn();
    const tracked = createTrackedFunction(notify, () => container.childVal?.name);

    tracked();
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Modify the child's property
    container.childVal!.name = "changed";

    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
  });

  it("modifying child in list notifies watcher of that child", () => {
    container.childList.push(new Item({ name: "list-item" }));

    const notify = vi.fn();
    const tracked = createTrackedFunction(notify, () => container.childList[0]?.name);

    tracked();
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Modify child's property through the list
    container.childList[0].name = "modified";

    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
  });

  it("non-child reference: modifying entity notifies reference watcher", () => {
    // For non-child refs, the item needs to be materialized first
    container.childVal = new Item({ name: "referenced" });
    container.valRef = container.childVal;

    const notify = vi.fn();
    const tracked = createTrackedFunction(notify, () => container.valRef?.name);

    tracked();
    // Modify through the container's child reference
    container.childVal!.name = "changed";

    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf.above(0);
  });
});
