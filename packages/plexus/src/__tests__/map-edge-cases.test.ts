/**
 * Edge Case & Security Tests for MaterializedMap
 *
 * Comprehensive edge case coverage:
 * - Duplicate keys (same canonical form)
 * - Generator exceptions mid-iteration (atomicity)
 * - Prototype pollution protection
 * - Key stability after assign
 * - Transaction behavior
 * - Self-referential key/value pairs
 * - Callback mutation during forEach
 * - Callback exceptions during forEach
 * - PathMap delete behavior during iteration
 * - Edge case keys (empty Set/Array, newlines)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { Plexus } from "../Plexus.js";
import { PlexusModel } from "../PlexusModel.js";
import type { PlexusMap } from "../proxy-runtime-types.js";
import { syncing } from "../decorators.js";
import { initTestPlexus } from "./test-plexus.js";

@syncing
class KeyModel extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing
class ValueModel extends PlexusModel {
  @syncing accessor data!: string;
}

@syncing
class TestContainer extends PlexusModel {
  @syncing.map accessor mapByString!: PlexusMap<string, ValueModel>;
  @syncing.map accessor mapBySet!: PlexusMap<Set<KeyModel>, ValueModel>;
  @syncing.map accessor mapByArray!: PlexusMap<KeyModel[], ValueModel>;
  @syncing.map accessor mapByModel!: PlexusMap<KeyModel, ValueModel>;
}

@syncing
class TestSite extends PlexusModel<null> {
  @syncing.child.list accessor containers!: TestContainer[];
  @syncing.child.list accessor keys!: KeyModel[];
}

describe("MaterializedMap edge cases", () => {
  let doc: Y.Doc;
  let site: TestSite;

  beforeEach(() => {
    const result = initTestPlexus(
      new TestSite({
        containers: [],
        keys: [],
      }),
    );
    doc = result.doc;
    site = result.root;
  });

  /** Helper to reduce boilerplate - creates and registers a TestContainer */
  function createContainer(): TestContainer {
    const container = new TestContainer({
      mapByString: new Map(),
      mapBySet: new Map(),
      mapByArray: new Map(),
      mapByModel: new Map(),
    });
    site.containers.push(container);
    return container;
  }

  describe("assign() with duplicate keys", () => {
    it("should handle entries with duplicate string keys - last wins", () => {
      const container = createContainer();

      const val1 = new ValueModel({ data: "first" });
      const val2 = new ValueModel({ data: "second" });
      const val3 = new ValueModel({ data: "third" });

      // Assign with duplicate keys - last value should win
      container.mapByString.assign([
        ["key", val1],
        ["key", val2],
        ["key", val3],
      ]);

      expect(container.mapByString.size).toBe(1);
      expect(container.mapByString.get("key")?.data).toBe("third");
    });

    it("should handle Set keys with same canonical form - last wins", () => {
      const container = createContainer();

      const k1 = new KeyModel({ name: "key1" });
      const k2 = new KeyModel({ name: "key2" });
      site.keys.push(k1, k2);

      const val1 = new ValueModel({ data: "first" });
      const val2 = new ValueModel({ data: "second" });

      // Same set, different order - should be treated as same key
      container.mapBySet.assign([
        [new Set([k1, k2]), val1],
        [new Set([k2, k1]), val2], // Same canonical form!
      ]);

      expect(container.mapBySet.size).toBe(1);
      expect(container.mapBySet.get(new Set([k1, k2]))?.data).toBe("second");
    });

    it("should distinguish Array keys with different order", () => {
      const container = createContainer();

      const k1 = new KeyModel({ name: "key1" });
      const k2 = new KeyModel({ name: "key2" });
      site.keys.push(k1, k2);

      const val1 = new ValueModel({ data: "first" });
      const val2 = new ValueModel({ data: "second" });

      // Different order = different keys for arrays
      container.mapByArray.assign([
        [[k1, k2], val1],
        [[k2, k1], val2],
      ]);

      expect(container.mapByArray.size).toBe(2);
      expect(container.mapByArray.get([k1, k2])?.data).toBe("first");
      expect(container.mapByArray.get([k2, k1])?.data).toBe("second");
    });
  });

  describe("assign() with generator that throws mid-iteration", () => {
    it("preserves old data when generator throws (best-effort atomicity)", () => {
      const container = createContainer();

      // Pre-populate the map
      container.mapByString.set("existing", new ValueModel({ data: "old" }));
      expect(container.mapByString.size).toBe(1);

      function* failingGenerator(): Generator<[string, ValueModel]> {
        yield ["a", new ValueModel({ data: "first" })];
        yield ["b", new ValueModel({ data: "second" })];
        throw new Error("Generator explosion!");
      }

      // assign() now preps data first, so generator throw happens before clear
      expect(() => {
        container.mapByString.assign(failingGenerator());
      }).toThrow("Generator explosion!");

      // Old data is preserved - nothing was cleared
      expect(container.mapByString.has("existing")).toBe(true);
      expect(container.mapByString.get("existing")?.data).toBe("old");
      expect(container.mapByString.size).toBe(1);

      // New data was never applied
      expect(container.mapByString.has("a")).toBe(false);
      expect(container.mapByString.has("b")).toBe(false);
    });

    it("transaction preserves old state when generator throws", () => {
      const container = createContainer();

      container.mapByString.set("before", new ValueModel({ data: "preserved" }));

      function* failingGenerator(): Generator<[string, ValueModel]> {
        yield ["new1", new ValueModel({ data: "new1" })];
        throw new Error("Mid-iteration failure");
      }

      expect(() => {
        doc.transact(() => {
          container.mapByString.assign(failingGenerator());
        }, Plexus);
      }).toThrow("Mid-iteration failure");

      // Old data is preserved
      expect(container.mapByString.has("before")).toBe(true);
      expect(container.mapByString.get("before")?.data).toBe("preserved");

      // New data was never applied
      expect(container.mapByString.has("new1")).toBe(false);
    });
  });

  describe("assign() with object having prototype properties", () => {
    it("should only use own enumerable properties, ignoring prototype", () => {
      const container = createContainer();

      // Create object with prototype pollution attempt
      const proto = { inherited: new ValueModel({ data: "from proto" }) };
      const obj = Object.create(proto);
      obj.own1 = new ValueModel({ data: "own1" });
      obj.own2 = new ValueModel({ data: "own2" });

      container.mapByString.assign(obj);

      // Should only have own properties
      expect(container.mapByString.size).toBe(2);
      expect(container.mapByString.has("own1")).toBe(true);
      expect(container.mapByString.has("own2")).toBe(true);
      expect(container.mapByString.has("inherited")).toBe(false);
    });

    it("should handle Object.prototype pollution attempts safely", () => {
      const container = createContainer();

      // Attempt prototype pollution via __proto__
      const malicious = {
        safe: new ValueModel({ data: "safe" }),
        // These should NOT pollute Object.prototype
        __proto__: { polluted: new ValueModel({ data: "evil" }) },
      };

      container.mapByString.assign(malicious as any);

      expect(container.mapByString.size).toBe(1);
      expect(container.mapByString.has("safe")).toBe(true);
      expect(container.mapByString.has("__proto__")).toBe(false);
      expect(container.mapByString.has("polluted")).toBe(false);

      // Verify Object.prototype wasn't polluted
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it("should handle constructor property safely", () => {
      const container = createContainer();

      const obj = {
        normal: new ValueModel({ data: "normal" }),
        constructor: new ValueModel({ data: "constructor value" }),
      };

      container.mapByString.assign(obj);

      // Constructor should be treated as a normal key
      expect(container.mapByString.size).toBe(2);
      expect(container.mapByString.has("constructor")).toBe(true);
      expect(container.mapByString.get("constructor")?.data).toBe("constructor value");
    });
  });

  describe("assign() followed by iteration - key stability", () => {
    it("should have stable keys immediately after assign", () => {
      const container = createContainer();

      const entries: [string, ValueModel][] = [
        ["c", new ValueModel({ data: "c" })],
        ["a", new ValueModel({ data: "a" })],
        ["b", new ValueModel({ data: "b" })],
      ];

      container.mapByString.assign(entries);

      // Keys should be available immediately
      const keys1 = [...container.mapByString.keys()];
      const keys2 = [...container.mapByString.keys()];

      expect(keys1).toEqual(keys2);
      expect(keys1.length).toBe(3);
    });

    it("should maintain insertion order after assign", () => {
      const container = createContainer();

      // Assign in specific order
      container.mapByString.assign([
        ["first", new ValueModel({ data: "1" })],
        ["second", new ValueModel({ data: "2" })],
        ["third", new ValueModel({ data: "3" })],
      ]);

      const keys = [...container.mapByString.keys()];
      expect(keys).toEqual(["first", "second", "third"]);
    });
  });

  describe("assign() during transaction vs outside", () => {
    it("should work identically inside and outside transaction", () => {
      const container1 = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      const container2 = new TestContainer({
        mapByString: new Map(),
        mapBySet: new Map(),
        mapByArray: new Map(),
        mapByModel: new Map(),
      });
      site.containers.push(container1, container2);

      const entries: [string, ValueModel][] = [
        ["a", new ValueModel({ data: "a" })],
        ["b", new ValueModel({ data: "b" })],
      ];

      // Outside transaction
      container1.mapByString.assign(entries);

      // Inside transaction
      doc.transact(() => {
        container2.mapByString.assign(entries);
      }, Plexus);

      expect(container1.mapByString.size).toBe(container2.mapByString.size);
      expect([...container1.mapByString.keys()]).toEqual([...container2.mapByString.keys()]);
    });

    it("should batch YJS updates within transaction", () => {
      const container = createContainer();

      const updateSpy = vi.fn();
      doc.on("update", updateSpy);

      doc.transact(() => {
        container.mapByString.assign([
          ["a", new ValueModel({ data: "a" })],
          ["b", new ValueModel({ data: "b" })],
          ["c", new ValueModel({ data: "c" })],
        ]);
      }, Plexus);

      // Should have been batched into fewer updates
      // (exact count depends on implementation)
      expect(updateSpy.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  describe("assign() with same model as key and value", () => {
    it("should handle model used as both key and value", () => {
      const container = createContainer();

      // Create a model that will be both key and part of a Set key
      const model = new KeyModel({ name: "dual-purpose" });
      site.keys.push(model);

      // Model as key in model-keyed map
      const value = new ValueModel({ data: "test" });
      container.mapByModel.assign([[model, value]]);

      expect(container.mapByModel.size).toBe(1);
      expect(container.mapByModel.get(model)).toBe(value);
    });

    it("should handle circular reference between key and value sets", () => {
      const container = createContainer();

      const k1 = new KeyModel({ name: "k1" });
      const k2 = new KeyModel({ name: "k2" });
      site.keys.push(k1, k2);

      const v1 = new ValueModel({ data: "v1" });
      const v2 = new ValueModel({ data: "v2" });

      // Multiple entries with overlapping set keys
      container.mapBySet.assign([
        [new Set([k1]), v1],
        [new Set([k2]), v2],
        [new Set([k1, k2]), v1], // Combination
      ]);

      expect(container.mapBySet.size).toBe(3);
      expect(container.mapBySet.get(new Set([k1]))).toBe(v1);
      expect(container.mapBySet.get(new Set([k2]))).toBe(v2);
      expect(container.mapBySet.get(new Set([k1, k2]))).toBe(v1);
    });
  });

  describe("forEach callback mutations", () => {
    it("BUG: mutation during forEach may cause unexpected behavior", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.set("c", new ValueModel({ data: "c" }));

      const visited: string[] = [];

      // Mutate map during iteration
      container.mapByString.forEach((value, key) => {
        visited.push(key as string);

        // Try to add a new key during iteration
        if (key === "b") {
          container.mapByString.set("d", new ValueModel({ data: "d" }));
        }
      });

      // BUG: The new key "d" might or might not be visited depending on
      // the iteration state when it was added
      // This documents current behavior - may not visit "d"
      expect(visited).toContain("a");
      expect(visited).toContain("b");
      expect(visited).toContain("c");

      // The key was added regardless
      expect(container.mapByString.has("d")).toBe(true);
    });

    it("BUG: deletion during forEach may skip entries", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.set("c", new ValueModel({ data: "c" }));

      const visited: string[] = [];

      // Delete entries during iteration
      container.mapByString.forEach((value, key) => {
        visited.push(key as string);

        // Delete "c" when visiting "a"
        if (key === "a") {
          container.mapByString.delete("c");
        }
      });

      // BUG: "c" may or may not be visited depending on iteration order
      // and internal implementation
      expect(visited).toContain("a");
      expect(visited).toContain("b");
      // We can't make strong assertions about "c" - behavior is undefined

      expect(container.mapByString.has("c")).toBe(false);
    });

    it("should handle clear during forEach", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.set("c", new ValueModel({ data: "c" }));

      const visited: string[] = [];

      // Clear during iteration - this is destructive
      container.mapByString.forEach((value, key) => {
        visited.push(key as string);

        if (key === "a") {
          container.mapByString.clear();
        }
      });

      // After clear, iteration should stop (no more entries)
      // But "a" was already being visited
      expect(visited.length).toBeGreaterThanOrEqual(1);
      expect(container.mapByString.size).toBe(0);
    });
  });

  describe("forEach callback throws", () => {
    it("should propagate exception from callback", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.set("c", new ValueModel({ data: "c" }));

      const visited: string[] = [];

      expect(() => {
        container.mapByString.forEach((value, key) => {
          visited.push(key as string);
          if (key === "b") {
            throw new Error("Callback explosion!");
          }
        });
      }).toThrow("Callback explosion!");

      // Should have visited at least "a" and "b" before throwing
      // (exact order depends on iteration)
      expect(visited.length).toBeGreaterThanOrEqual(1);
    });

    it("should preserve map state after callback throws", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.set("c", new ValueModel({ data: "c" }));

      try {
        container.mapByString.forEach(() => {
          throw new Error("fail");
        });
      } catch {
        // Expected
      }

      // Map should be unchanged
      expect(container.mapByString.size).toBe(3);
      expect(container.mapByString.get("a")?.data).toBe("a");
      expect(container.mapByString.get("b")?.data).toBe("b");
      expect(container.mapByString.get("c")?.data).toBe("c");
    });

    it("should support thisArg correctly", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));

      const context = { captured: false };

      container.mapByString.forEach(function (this: typeof context) {
        this.captured = true;
      }, context);

      expect(context.captured).toBe(true);
    });
  });

  describe("assign() edge cases with empty iterables", () => {
    function* emptyGen(): Generator<[string, ValueModel]> {
      // Yields nothing
    }

    it.each([
      ["empty array", [] as [string, ValueModel][]],
      ["empty object", {} as Record<string, ValueModel>],
      ["empty generator", emptyGen()],
    ])("should clear map when assigned %s", (_desc, emptyInput) => {
      const container = createContainer();
      container.mapByString.set("existing", new ValueModel({ data: "old" }));
      container.mapByString.assign(emptyInput);
      expect(container.mapByString.size).toBe(0);
    });
  });

  describe("PathMap delete behavior during iteration", () => {
    it("delete() properly removes entries from iteration", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      expect(container.mapByString.size).toBe(2);

      container.mapByString.delete("a");
      expect(container.mapByString.size).toBe(1);

      // entries() only yields remaining entries
      const entries = [...container.mapByString.entries()];
      expect(entries.length).toBe(1);
      expect(entries[0][0]).toBe("b");
      expect(entries[0][1].data).toBe("b");

      // Verify accessors
      expect(container.mapByString.get("b")?.data).toBe("b");
      expect(container.mapByString.has("a")).toBe(false);
    });

    it("keys() iterator excludes deleted keys", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.delete("a");

      const keys = [...container.mapByString.keys()];
      expect(keys.length).toBe(1);
      expect(keys).not.toContain("a");
      expect(keys).toContain("b");
    });

    it("values() iterator excludes deleted entries", () => {
      const container = createContainer();

      container.mapByString.set("a", new ValueModel({ data: "a" }));
      container.mapByString.set("b", new ValueModel({ data: "b" }));
      container.mapByString.delete("a");

      const values = [...container.mapByString.values()];
      expect(values.length).toBe(1);
      expect(values[0].data).toBe("b");
      expect(values).not.toContain(undefined);
    });
  });

  describe("edge case keys", () => {
    it("handles empty Set as key", () => {
      const container = createContainer();

      const emptySet = new Set<KeyModel>();
      const value = new ValueModel({ data: "empty-set-value" });

      container.mapBySet.set(emptySet, value);
      expect(container.mapBySet.size).toBe(1);
      expect(container.mapBySet.get(new Set())?.data).toBe("empty-set-value");
      expect(container.mapBySet.has(new Set())).toBe(true);
    });

    it("handles empty Array as key", () => {
      const container = createContainer();

      const emptyArray: KeyModel[] = [];
      const value = new ValueModel({ data: "empty-array-value" });

      container.mapByArray.set(emptyArray, value);
      expect(container.mapByArray.size).toBe(1);
      expect(container.mapByArray.get([])?.data).toBe("empty-array-value");
      expect(container.mapByArray.has([])).toBe(true);
    });

    it("handles string keys with newlines (escaped in JSON)", () => {
      const container = createContainer();

      const keyWithNewline = "hello\nworld";
      const value = new ValueModel({ data: "newline-key-value" });

      container.mapByString.set(keyWithNewline, value);
      expect(container.mapByString.size).toBe(1);
      expect(container.mapByString.get("hello\nworld")?.data).toBe("newline-key-value");
      expect(container.mapByString.has("hello\nworld")).toBe(true);

      // Different string should not match
      expect(container.mapByString.has("helloworld")).toBe(false);
      expect(container.mapByString.has("hello")).toBe(false);
    });
  });
});
