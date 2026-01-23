/**
 * Null handling edge case tests
 *
 * Tests behavior of null values across all field types:
 * - Nullable primitive fields
 * - Nullable child references
 * - Null entries in collections (arrays, records, maps, sets)
 * - Transitions between null and non-null states
 */

import { describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { createTrackedFunction } from "../../tracking.js";

@syncing
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing
class NullableContainer extends PlexusModel<null> {
  @syncing accessor nullableString: string | null = null;
  @syncing accessor nullableNumber: number | null = null;
  @syncing accessor nullableBoolean: boolean | null = null;
  @syncing.child accessor nullableChild: Item | null = null;
  @syncing.child.list accessor children: (Item | null)[] = [];
  @syncing.child.record accessor childRecord: Record<string, Item | null> = {};
}

describe("Null Handling Edge Cases", () => {
  describe("nullable primitive fields", () => {
    it("initializes nullable fields as null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      expect([root.nullableString, root.nullableNumber, root.nullableBoolean]).to.have.ordered.members([
        null,
        null,
        null,
      ]);
    });

    it("can set nullable field from null to value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.nullableString = "hello";
      root.nullableNumber = 42;
      root.nullableBoolean = true;

      expect([root.nullableString, root.nullableNumber, root.nullableBoolean]).to.have.ordered.members([
        "hello",
        42,
        true,
      ]);
    });

    it("can set nullable field from value back to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.nullableString = "hello";
      root.nullableString = null;
      root.nullableNumber = 42;
      root.nullableNumber = null;

      expect([root.nullableString, root.nullableNumber]).to.have.ordered.members([null, null]);
    });

    it("distinguishes null from undefined in nullable fields", () => {
      const { root } = initTestPlexus(new NullableContainer());

      // Null is the explicit empty value
      expect(root.nullableString).to.eq(null);
      expect(root.nullableString).to.not.eq(undefined);

      // Setting a value and then null
      root.nullableString = "test";
      root.nullableString = null;
      expect(root.nullableString).to.eq(null);
    });
  });

  describe("nullable child references", () => {
    it("initializes nullable child as null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      expect(root.nullableChild).to.eq(null);
    });

    it("can assign child to nullable field", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child = new Item({ name: "test" });

      root.nullableChild = child;
      expect([root.nullableChild !== null, root.nullableChild!.name]).to.have.ordered.members([true, "test"]);
    });

    it("can clear child back to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child = new Item({ name: "test" });

      root.nullableChild = child;
      root.nullableChild = null;
      expect(root.nullableChild).to.eq(null);
    });

    it("can replace one child with another", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child1 = new Item({ name: "first" });
      const child2 = new Item({ name: "second" });

      root.nullableChild = child1;
      const firstName = root.nullableChild!.name;

      root.nullableChild = child2;
      expect([firstName, root.nullableChild!.name]).to.have.ordered.members(["first", "second"]);
    });
  });

  describe("null entries in arrays", () => {
    it("can push null to array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(null);
      expect([root.children.length, root.children[0]]).to.have.ordered.members([1, null]);
    });

    it("can have mixed null and non-null entries", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(null);
      root.children.push(new Item({ name: "third" }));

      expect([
        root.children.length,
        root.children[0]!.name,
        root.children[1],
        root.children[2]!.name,
      ]).to.have.ordered.members([3, "first", null, "third"]);
    });

    it("can set array element to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "will-be-nulled" }));
      const beforeNull = root.children[0]!.name;

      root.children[0] = null;
      expect([beforeNull, root.children[0]]).to.have.ordered.members(["will-be-nulled", null]);
    });

    it("can set null element to non-null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(null);
      const wasNull = root.children[0];

      root.children[0] = new Item({ name: "was-null" });
      expect([wasNull, root.children[0]!.name]).to.have.ordered.members([null, "was-null"]);
    });

    it("handles splice with null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(new Item({ name: "second" }));

      // Insert null in the middle
      root.children.splice(1, 0, null);

      expect([
        root.children.length,
        root.children[0]!.name,
        root.children[1],
        root.children[2]!.name,
      ]).to.have.ordered.members([3, "first", null, "second"]);
    });

    it("handles unshift with null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "existing" }));
      root.children.unshift(null);

      expect([root.children.length, root.children[0], root.children[1]!.name]).to.have.ordered.members([
        2,
        null,
        "existing",
      ]);
    });
  });

  describe("null entries in records", () => {
    it("can set null value in record", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["empty"] = null;
      // Null values are treated as deletion in records
      expect("empty" in root.childRecord).to.eq(false);
    });

    it("setting to null removes the key", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "will-be-removed" });
      const beforeRemove = "key" in root.childRecord;

      root.childRecord["key"] = null;
      expect([beforeRemove, "key" in root.childRecord]).to.have.ordered.members([true, false]);
    });

    it("delete removes key just like setting to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "to-delete" });
      const beforeDelete = "key" in root.childRecord;

      delete root.childRecord["key"];
      expect([beforeDelete, "key" in root.childRecord]).to.have.ordered.members([true, false]);
    });
  });

  describe("null reactivity", () => {
    it("notifies when nullable field changes to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.nullableString = "initial";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.nullableString);
      tracked();

      root.nullableString = null;
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when nullable field changes from null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.nullableString);
      tracked();

      root.nullableString = "set-from-null";
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when nullable child cleared", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.nullableChild = new Item({ name: "test" });

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.nullableChild);
      tracked();

      root.nullableChild = null;
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });

    it("notifies when array element set to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.children.push(new Item({ name: "test" }));

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.children[0]);
      tracked();

      root.children[0] = null;
      expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    });
  });

  describe("null edge cases", () => {
    it("handles multiple null entries in array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      // Multiple nulls are allowed (unlike child duplicates)
      root.children.push(null, null, null);
      expect([root.children.length, root.children.every((c) => c === null)]).to.have.ordered.members([3, true]);
    });

    it("can filter out nulls from array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(null);
      root.children.push(new Item({ name: "third" }));
      root.children.push(null);

      const nonNull = root.children.filter((c): c is Item => c !== null);
      expect([nonNull.length, nonNull[0].name, nonNull[1].name]).to.have.ordered.members([2, "first", "third"]);
    });

    it("assigns array with mixed null values", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const item1 = new Item({ name: "a" });
      const item2 = new Item({ name: "b" });

      (root.children as any).assign([item1, null, item2, null]);

      expect([
        root.children.length,
        root.children[0]!.name,
        root.children[1],
        root.children[2]!.name,
        root.children[3],
      ]).to.have.ordered.members([4, "a", null, "b", null]);
    });
  });
});
