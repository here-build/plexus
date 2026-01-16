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

      expect(root.nullableString).toBeNull();
      expect(root.nullableNumber).toBeNull();
      expect(root.nullableBoolean).toBeNull();
    });

    it("can set nullable field from null to value", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.nullableString = "hello";
      expect(root.nullableString).toBe("hello");

      root.nullableNumber = 42;
      expect(root.nullableNumber).toBe(42);

      root.nullableBoolean = true;
      expect(root.nullableBoolean).toBe(true);
    });

    it("can set nullable field from value back to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.nullableString = "hello";
      root.nullableString = null;
      expect(root.nullableString).toBeNull();

      root.nullableNumber = 42;
      root.nullableNumber = null;
      expect(root.nullableNumber).toBeNull();
    });

    it("distinguishes null from undefined in nullable fields", () => {
      const { root } = initTestPlexus(new NullableContainer());

      // Null is the explicit empty value
      expect(root.nullableString).toBeNull();
      expect(root.nullableString).not.toBeUndefined();

      // Setting a value and then null
      root.nullableString = "test";
      root.nullableString = null;
      expect(root.nullableString).toBeNull();
    });
  });

  describe("nullable child references", () => {
    it("initializes nullable child as null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      expect(root.nullableChild).toBeNull();
    });

    it("can assign child to nullable field", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child = new Item({ name: "test" });

      root.nullableChild = child;
      expect(root.nullableChild).not.toBeNull();
      expect(root.nullableChild!.name).toBe("test");
    });

    it("can clear child back to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child = new Item({ name: "test" });

      root.nullableChild = child;
      root.nullableChild = null;
      expect(root.nullableChild).toBeNull();
    });

    it("can replace one child with another", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const child1 = new Item({ name: "first" });
      const child2 = new Item({ name: "second" });

      root.nullableChild = child1;
      expect(root.nullableChild!.name).toBe("first");

      root.nullableChild = child2;
      expect(root.nullableChild!.name).toBe("second");
    });
  });

  describe("null entries in arrays", () => {
    it("can push null to array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(null);
      expect(root.children.length).toBe(1);
      expect(root.children[0]).toBeNull();
    });

    it("can have mixed null and non-null entries", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(null);
      root.children.push(new Item({ name: "third" }));

      expect(root.children.length).toBe(3);
      expect(root.children[0]!.name).toBe("first");
      expect(root.children[1]).toBeNull();
      expect(root.children[2]!.name).toBe("third");
    });

    it("can set array element to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "will-be-nulled" }));
      expect(root.children[0]!.name).toBe("will-be-nulled");

      root.children[0] = null;
      expect(root.children[0]).toBeNull();
    });

    it("can set null element to non-null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(null);
      expect(root.children[0]).toBeNull();

      root.children[0] = new Item({ name: "was-null" });
      expect(root.children[0]!.name).toBe("was-null");
    });

    it("handles splice with null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(new Item({ name: "second" }));

      // Insert null in the middle
      root.children.splice(1, 0, null);

      expect(root.children.length).toBe(3);
      expect(root.children[0]!.name).toBe("first");
      expect(root.children[1]).toBeNull();
      expect(root.children[2]!.name).toBe("second");
    });

    it("handles unshift with null values", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "existing" }));
      root.children.unshift(null);

      expect(root.children.length).toBe(2);
      expect(root.children[0]).toBeNull();
      expect(root.children[1]!.name).toBe("existing");
    });
  });

  describe("null entries in records", () => {
    it("can set null value in record", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["empty"] = null;
      // Null values are treated as deletion in records
      expect("empty" in root.childRecord).toBe(false);
    });

    it("setting to null removes the key", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "will-be-removed" });
      expect("key" in root.childRecord).toBe(true);

      root.childRecord["key"] = null;
      expect("key" in root.childRecord).toBe(false);
    });

    it("delete removes key just like setting to null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.childRecord["key"] = new Item({ name: "to-delete" });
      expect("key" in root.childRecord).toBe(true);

      delete root.childRecord["key"];
      expect("key" in root.childRecord).toBe(false);
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
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies when nullable field changes from null", () => {
      const { root } = initTestPlexus(new NullableContainer());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.nullableString);
      tracked();

      root.nullableString = "set-from-null";
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies when nullable child cleared", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.nullableChild = new Item({ name: "test" });

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.nullableChild);
      tracked();

      root.nullableChild = null;
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies when array element set to null", () => {
      const { root } = initTestPlexus(new NullableContainer());
      root.children.push(new Item({ name: "test" }));

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.children[0]);
      tracked();

      root.children[0] = null;
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("null edge cases", () => {
    it("handles multiple null entries in array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      // Multiple nulls are allowed (unlike child duplicates)
      root.children.push(null, null, null);
      expect(root.children.length).toBe(3);
      expect(root.children.every((c) => c === null)).toBe(true);
    });

    it("can filter out nulls from array", () => {
      const { root } = initTestPlexus(new NullableContainer());

      root.children.push(new Item({ name: "first" }));
      root.children.push(null);
      root.children.push(new Item({ name: "third" }));
      root.children.push(null);

      const nonNull = root.children.filter((c): c is Item => c !== null);
      expect(nonNull.length).toBe(2);
      expect(nonNull[0].name).toBe("first");
      expect(nonNull[1].name).toBe("third");
    });

    it("assigns array with mixed null values", () => {
      const { root } = initTestPlexus(new NullableContainer());
      const item1 = new Item({ name: "a" });
      const item2 = new Item({ name: "b" });

      (root.children as any).assign([item1, null, item2, null]);

      expect(root.children.length).toBe(4);
      expect(root.children[0]!.name).toBe("a");
      expect(root.children[1]).toBeNull();
      expect(root.children[2]!.name).toBe("b");
      expect(root.children[3]).toBeNull();
    });
  });
});
