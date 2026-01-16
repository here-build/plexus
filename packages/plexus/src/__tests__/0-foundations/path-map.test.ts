/**
 * Unit tests for PathMap - the trie-based Map with structural key equality
 *
 * Tests internal mechanics:
 * - canonicalSort ordering
 * - Trie root selection (flat/set/array keys)
 * - Canonical node/key resolution
 * - WeakRef behavior after delete
 * - Insertion order preservation
 * - Size tracking accuracy
 */

import { describe, expect, it } from "vitest";

import { canonicalSort, PathMap } from "../../proxies/PathMap.js";

describe("PathMap", () => {
  describe("canonicalSort", () => {
    it("should sort primitives by type first, then by value", () => {
      const items = [3, "b", true, 1, "a", false, 2, null];
      const sorted = [...items].sort(canonicalSort);

      // Expected order: booleans (false, true), null, numbers (1,2,3), strings (a,b)
      expect(sorted).toEqual([false, true, null, 1, 2, 3, "a", "b"]);
    });

    it("should handle BigInt values", () => {
      const items = [3n, 1n, 2n];
      const sorted = [...items].sort(canonicalSort);
      expect(sorted).toEqual([1n, 2n, 3n]);
    });

    it("should sort mixed numeric types separately", () => {
      const items = [2, 1n, 1, 2n];
      const sorted = [...items].sort(canonicalSort);

      // BigInt and number are different types
      expect(sorted[0]).toBe(1n);
      expect(sorted[1]).toBe(2n);
      expect(sorted[2]).toBe(1);
      expect(sorted[3]).toBe(2);
    });

    it("should handle negative numbers correctly", () => {
      const items = [3, -1, 0, -2, 2];
      const sorted = [...items].sort(canonicalSort);
      // String comparison: "-1" < "-2" < "0" < "2" < "3"
      expect(sorted).toEqual([-1, -2, 0, 2, 3]);
    });
  });

  describe("basic Map operations", () => {
    it("should implement full Map interface", () => {
      const map = new PathMap<string, number>();

      map.set("a", 1);
      map.set("b", 2);

      expect(map.size).toBe(2);
      expect(map.get("a")).toBe(1);
      expect(map.get("b")).toBe(2);
      expect(map.has("a")).toBe(true);
      expect(map.has("c")).toBe(false);

      expect(map.delete("a")).toBe(true);
      expect(map.delete("a")).toBe(false); // Already deleted
      expect(map.size).toBe(1);

      map.clear();
      expect(map.size).toBe(0);
    });

    it("should have correct Symbol.toStringTag", () => {
      const map = new PathMap<string, number>();
      expect(map[Symbol.toStringTag]).toBe("PathMap");
      expect(Object.prototype.toString.call(map)).toBe("[object PathMap]");
    });
  });

  describe("trie root selection", () => {
    it("should use separate roots for flat, Set, and Array keys", () => {
      const map = new PathMap<string | Set<string> | string[], number>();

      // These should all be stored in different trie roots
      map.set("a", 1);
      map.set(new Set(["a"]), 2);
      map.set(["a"], 3);

      expect(map.size).toBe(3);
      expect(map.get("a")).toBe(1);
      expect(map.get(new Set(["a"]))).toBe(2);
      expect(map.get(["a"])).toBe(3);
    });

    it("should not confuse empty containers with each other", () => {
      const map = new PathMap<Set<string> | string[], number>();

      map.set(new Set(), 1);
      map.set([], 2);

      expect(map.size).toBe(2);
      expect(map.get(new Set())).toBe(1);
      expect(map.get([])).toBe(2);
    });
  });

  describe("Set key canonicalization", () => {
    it("should treat Sets with same elements as equal regardless of order", () => {
      const map = new PathMap<Set<string>, number>();

      map.set(new Set(["a", "b", "c"]), 1);

      // Different insertion order, same canonical form
      expect(map.get(new Set(["c", "b", "a"]))).toBe(1);
      expect(map.get(new Set(["b", "a", "c"]))).toBe(1);
      expect(map.has(new Set(["a", "c", "b"]))).toBe(true);
    });

    it("should distinguish Sets with different elements", () => {
      const map = new PathMap<Set<string>, number>();

      map.set(new Set(["a", "b"]), 1);
      map.set(new Set(["a", "c"]), 2);

      expect(map.size).toBe(2);
      expect(map.get(new Set(["a", "b"]))).toBe(1);
      expect(map.get(new Set(["a", "c"]))).toBe(2);
    });
  });

  describe("Array key ordering", () => {
    it("should treat Arrays as order-sensitive", () => {
      const map = new PathMap<string[], number>();

      map.set(["a", "b"], 1);
      map.set(["b", "a"], 2);

      expect(map.size).toBe(2);
      expect(map.get(["a", "b"])).toBe(1);
      expect(map.get(["b", "a"])).toBe(2);
    });

    it("should treat identical Arrays as equal", () => {
      const map = new PathMap<number[], string>();

      map.set([1, 2, 3], "first");

      expect(map.get([1, 2, 3])).toBe("first");
      expect(map.has([1, 2, 3])).toBe(true);
    });
  });

  describe("canonical key resolution", () => {
    it("should return stable canonical key for Set keys", () => {
      const map = new PathMap<Set<string>, number>();

      const key1 = new Set(["a", "b"]);
      map.set(key1, 1);

      const canonical1 = map.getCanonicalKey(key1);
      const canonical2 = map.getCanonicalKey(new Set(["b", "a"]));

      // Same canonical key object
      expect(canonical1).toBe(canonical2);
    });

    it("should return stable canonical key for Array keys", () => {
      const map = new PathMap<number[], string>();

      map.set([1, 2], "value");

      const canonical1 = map.getCanonicalKey([1, 2]);
      const canonical2 = map.getCanonicalKey([1, 2]);

      expect(canonical1).toBe(canonical2);
      // Array canonical keys are frozen
      expect(Object.isFrozen(canonical1)).toBe(true);
    });

    it("should return undefined for maybeGetCanonicalKey on missing key", () => {
      const map = new PathMap<string, number>();

      expect(map.maybeGetCanonicalKey("missing")).toBeUndefined();
    });

    it("should create canonical key on getCanonicalKey even for missing keys", () => {
      const map = new PathMap<Set<string>, number>();

      // Key doesn't exist but getCanonicalKey creates canonical form
      const canonical = map.getCanonicalKey(new Set(["x", "y"]));

      expect(canonical).toBeInstanceOf(Set);
      expect([...canonical]).toEqual(["x", "y"]);
    });
  });

  describe("delete and WeakRef behavior", () => {
    it("should preserve canonical key as WeakRef after delete for Sets", () => {
      const map = new PathMap<Set<string>, number>();

      const key = new Set(["a", "b"]);
      map.set(key, 1);

      const canonicalBefore = map.getCanonicalKey(key);
      map.delete(key);

      // After delete, canonical key should still be resolvable if original is alive
      const canonicalAfter = map.maybeGetCanonicalKey(key);
      expect(canonicalAfter).toBe(canonicalBefore);
    });

    it("should remove from iteration after delete", () => {
      const map = new PathMap<string, number>();

      map.set("a", 1);
      map.set("b", 2);
      map.set("c", 3);

      map.delete("b");

      const keys = [...map.keys()];
      expect(keys).toHaveLength(2);
      expect(keys).toContain("a");
      expect(keys).toContain("c");
      expect(keys).not.toContain("b");
    });

    it("should update size correctly on delete", () => {
      const map = new PathMap<string, number>();

      map.set("a", 1);
      map.set("b", 2);
      expect(map.size).toBe(2);

      map.delete("a");
      expect(map.size).toBe(1);

      map.delete("nonexistent");
      expect(map.size).toBe(1); // No change
    });
  });

  describe("iteration order", () => {
    it("should preserve insertion order in keys()", () => {
      const map = new PathMap<string, number>();

      map.set("c", 3);
      map.set("a", 1);
      map.set("b", 2);

      expect([...map.keys()]).toEqual(["c", "a", "b"]);
    });

    it("should preserve insertion order in values()", () => {
      const map = new PathMap<string, number>();

      map.set("c", 3);
      map.set("a", 1);
      map.set("b", 2);

      expect([...map.values()]).toEqual([3, 1, 2]);
    });

    it("should preserve insertion order in entries()", () => {
      const map = new PathMap<string, number>();

      map.set("c", 3);
      map.set("a", 1);
      map.set("b", 2);

      expect([...map.entries()]).toEqual([
        ["c", 3],
        ["a", 1],
        ["b", 2],
      ]);
    });

    it("should work with forEach", () => {
      const map = new PathMap<string, number>();

      map.set("x", 10);
      map.set("y", 20);

      const collected: [string, number][] = [];
      map.forEach((value, key) => {
        collected.push([key, value]);
      });

      expect(collected).toEqual([
        ["x", 10],
        ["y", 20],
      ]);
    });

    it("should support Symbol.iterator", () => {
      const map = new PathMap<string, number>();

      map.set("a", 1);
      map.set("b", 2);

      const entries = [...map];
      expect(entries).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    });
  });

  describe("update existing keys", () => {
    it("should update value without changing size", () => {
      const map = new PathMap<string, number>();

      map.set("key", 1);
      expect(map.size).toBe(1);

      map.set("key", 2);
      expect(map.size).toBe(1);
      expect(map.get("key")).toBe(2);
    });

    it("should keep same canonical key on update", () => {
      const map = new PathMap<Set<string>, number>();

      const key = new Set(["a", "b"]);
      map.set(key, 1);
      const canonical1 = map.getCanonicalKey(key);

      map.set(new Set(["b", "a"]), 2);
      const canonical2 = map.getCanonicalKey(key);

      expect(canonical1).toBe(canonical2);
      expect(map.get(key)).toBe(2);
    });
  });

  describe("mixed key types in containers", () => {
    it("should handle Set with mixed primitive types", () => {
      const map = new PathMap<Set<string | number | boolean>, string>();

      const key = new Set<string | number | boolean>(["a", 1, true]);
      map.set(key, "mixed");

      // Same elements, different object
      expect(map.get(new Set([true, "a", 1]))).toBe("mixed");
    });

    it("should handle Array with mixed primitive types", () => {
      const map = new PathMap<(string | number | null)[], string>();

      map.set(["a", 1, null], "mixed");

      expect(map.get(["a", 1, null])).toBe("mixed");
      // Different order = different key
      expect(map.get([1, "a", null])).toBeUndefined();
    });
  });

  describe("null handling", () => {
    it("should support null as a primitive key", () => {
      const map = new PathMap<string | null, number>();

      map.set(null, 1);
      map.set("null", 2); // String "null" is different

      expect(map.size).toBe(2);
      expect(map.get(null)).toBe(1);
      expect(map.get("null")).toBe(2);
    });

    it("should support null in Set keys", () => {
      const map = new PathMap<Set<string | null>, number>();

      map.set(new Set([null, "a"]), 1);

      expect(map.get(new Set(["a", null]))).toBe(1);
    });
  });

  describe("special numeric values", () => {
    it("should handle Infinity as key", () => {
      const map = new PathMap<number, string>();

      map.set(Infinity, "pos");
      map.set(-Infinity, "neg");

      expect(map.size).toBe(2);
      expect(map.get(Infinity)).toBe("pos");
      expect(map.get(-Infinity)).toBe("neg");
    });

    it("should handle NaN as key (same identity)", () => {
      const map = new PathMap<number, string>();

      map.set(NaN, "first");
      map.set(NaN, "second"); // Same key

      expect(map.size).toBe(1);
      expect(map.get(NaN)).toBe("second");
    });

    it("should handle BigInt as key", () => {
      const map = new PathMap<bigint, string>();

      map.set(123n, "small");
      map.set(999999999999999999999999n, "large");

      expect(map.size).toBe(2);
      expect(map.get(123n)).toBe("small");
      expect(map.get(999999999999999999999999n)).toBe("large");
    });
  });
});
