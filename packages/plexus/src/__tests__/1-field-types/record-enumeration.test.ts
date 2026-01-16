/**
 * Record enumeration tests
 *
 * Tests for Object.keys(), Object.values(), Object.entries(),
 * for...in loops, spread operator, and other enumeration methods
 * on Plexus record fields.
 */

import { describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { createTrackedFunction } from "../../tracking.js";

@syncing
class Item extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor value: number = 0;
}

@syncing
class Container extends PlexusModel<null> {
  @syncing.record accessor primitiveRecord: Record<string, string> = {};
  @syncing.child.record accessor childRecord: Record<string, Item> = {};
}

describe("Record Enumeration", () => {
  describe("Object.keys()", () => {
    it("returns empty array for empty record", () => {
      const { root } = initTestPlexus(new Container());
      expect(Object.keys(root.primitiveRecord)).toEqual([]);
    });

    it("returns keys of primitive record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["a"] = "valueA";
      root.primitiveRecord["b"] = "valueB";
      root.primitiveRecord["c"] = "valueC";

      const keys = Object.keys(root.primitiveRecord);
      expect(keys).toHaveLength(3);
      expect(keys).toContain("a");
      expect(keys).toContain("b");
      expect(keys).toContain("c");
    });

    it("returns keys of child record", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["first"] = new Item({ name: "First" });
      root.childRecord["second"] = new Item({ name: "Second" });

      const keys = Object.keys(root.childRecord);
      expect(keys).toHaveLength(2);
      expect(keys).toContain("first");
      expect(keys).toContain("second");
    });

    it("updates after adding keys", () => {
      const { root } = initTestPlexus(new Container());

      expect(Object.keys(root.primitiveRecord)).toHaveLength(0);

      root.primitiveRecord["new"] = "value";
      expect(Object.keys(root.primitiveRecord)).toHaveLength(1);
      expect(Object.keys(root.primitiveRecord)).toContain("new");
    });

    it("updates after removing keys", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["key"] = "value";
      expect(Object.keys(root.primitiveRecord)).toContain("key");

      delete root.primitiveRecord["key"];
      expect(Object.keys(root.primitiveRecord)).not.toContain("key");
    });
  });

  describe("Object.values()", () => {
    it("returns empty array for empty record", () => {
      const { root } = initTestPlexus(new Container());
      expect(Object.values(root.primitiveRecord)).toEqual([]);
    });

    it("returns values of primitive record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["a"] = "alpha";
      root.primitiveRecord["b"] = "beta";

      const values = Object.values(root.primitiveRecord);
      expect(values).toHaveLength(2);
      expect(values).toContain("alpha");
      expect(values).toContain("beta");
    });

    it("returns child instances from child record", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["one"] = new Item({ name: "One", value: 1 });
      root.childRecord["two"] = new Item({ name: "Two", value: 2 });

      const values = Object.values(root.childRecord);
      expect(values).toHaveLength(2);
      expect(values.map((v) => v.name).sort()).toEqual(["One", "Two"]);
    });
  });

  describe("Object.entries()", () => {
    it("returns empty array for empty record", () => {
      const { root } = initTestPlexus(new Container());
      expect(Object.entries(root.primitiveRecord)).toEqual([]);
    });

    it("returns key-value pairs for primitive record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["x"] = "X";
      root.primitiveRecord["y"] = "Y";

      const entries = Object.entries(root.primitiveRecord);
      expect(entries).toHaveLength(2);

      const obj = Object.fromEntries(entries);
      expect(obj).toEqual({ x: "X", y: "Y" });
    });

    it("returns key-child pairs for child record", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["item1"] = new Item({ name: "Item1" });
      root.childRecord["item2"] = new Item({ name: "Item2" });

      const entries = Object.entries(root.childRecord);
      expect(entries).toHaveLength(2);

      for (const [key, value] of entries) {
        expect(typeof key).toBe("string");
        expect(value).toBeInstanceOf(Item);
      }
    });
  });

  describe("for...in enumeration", () => {
    it("iterates over empty record without iterations", () => {
      const { root } = initTestPlexus(new Container());
      const keys: string[] = [];

      for (const key in root.primitiveRecord) {
        keys.push(key);
      }

      expect(keys).toHaveLength(0);
    });

    it("iterates over all keys in record", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["first"] = "1";
      root.primitiveRecord["second"] = "2";
      root.primitiveRecord["third"] = "3";

      const keys: string[] = [];
      for (const key in root.primitiveRecord) {
        keys.push(key);
      }

      expect(keys).toHaveLength(3);
      expect(keys).toContain("first");
      expect(keys).toContain("second");
      expect(keys).toContain("third");
    });
  });

  describe("spread operator", () => {
    it("spreads empty record to empty object", () => {
      const { root } = initTestPlexus(new Container());
      const spread = { ...root.primitiveRecord };

      expect(Object.keys(spread)).toHaveLength(0);
    });

    it("spreads record contents", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["a"] = "A";
      root.primitiveRecord["b"] = "B";

      const spread = { ...root.primitiveRecord };
      expect(spread).toEqual({ a: "A", b: "B" });
    });

    it("spreads child record with live references", () => {
      const { root } = initTestPlexus(new Container());

      root.childRecord["item"] = new Item({ name: "Original" });

      const spread = { ...root.childRecord };
      expect(spread.item.name).toBe("Original");

      // Changes to original reflect in spread (same reference)
      root.childRecord["item"].name = "Modified";
      expect(spread.item.name).toBe("Modified");
    });
  });

  describe("Object.hasOwn / in operator", () => {
    it("returns false for non-existent key", () => {
      const { root } = initTestPlexus(new Container());

      expect(Object.hasOwn(root.primitiveRecord, "missing")).toBe(false);
      expect("missing" in root.primitiveRecord).toBe(false);
    });

    it("returns true for existing key", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["exists"] = "value";

      expect(Object.hasOwn(root.primitiveRecord, "exists")).toBe(true);
      expect("exists" in root.primitiveRecord).toBe(true);
    });

    it("returns false after key deletion", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["temp"] = "temporary";
      expect("temp" in root.primitiveRecord).toBe(true);

      delete root.primitiveRecord["temp"];
      expect("temp" in root.primitiveRecord).toBe(false);
    });
  });

  describe("enumeration reactivity", () => {
    it("notifies when iterating keys and key added", () => {
      const { root } = initTestPlexus(new Container());
      root.primitiveRecord["initial"] = "value";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.keys(root.primitiveRecord));
      tracked();

      root.primitiveRecord["new"] = "newValue";
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies when iterating keys and key removed", () => {
      const { root } = initTestPlexus(new Container());
      root.primitiveRecord["toRemove"] = "value";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.keys(root.primitiveRecord));
      tracked();

      delete root.primitiveRecord["toRemove"];
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies when using 'in' operator and key presence changes", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => "key" in root.primitiveRecord);
      tracked();

      root.primitiveRecord["key"] = "value";
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("edge cases", () => {
    it("handles numeric string keys", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["0"] = "zero";
      root.primitiveRecord["1"] = "one";
      root.primitiveRecord["100"] = "hundred";

      expect(Object.keys(root.primitiveRecord)).toContain("0");
      expect(Object.keys(root.primitiveRecord)).toContain("1");
      expect(Object.keys(root.primitiveRecord)).toContain("100");
    });

    it("handles keys with special characters", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["with-dash"] = "dash";
      root.primitiveRecord["with.dot"] = "dot";
      root.primitiveRecord["with_underscore"] = "underscore";

      const keys = Object.keys(root.primitiveRecord);
      expect(keys).toContain("with-dash");
      expect(keys).toContain("with.dot");
      expect(keys).toContain("with_underscore");
    });

    it("preserves key order (insertion order)", () => {
      const { root } = initTestPlexus(new Container());

      root.primitiveRecord["z"] = "last";
      root.primitiveRecord["a"] = "first";
      root.primitiveRecord["m"] = "middle";

      const keys = Object.keys(root.primitiveRecord);
      // JavaScript objects maintain insertion order for string keys
      expect(keys).toEqual(["z", "a", "m"]);
    });
  });
});
