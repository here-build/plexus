/**
 * Unit tests for key-serialization edge cases
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { deserializeKey, serializeKey } from "../../proxies/key-serialization.js";
import { PathMap } from "../../proxies/PathMap.js";

describe("key-serialization", () => {
  const doc = new Y.Doc();

  describe("special numeric values", () => {
    it("handles Infinity", () => {
      const serialized = serializeKey(Infinity, doc);
      expect(serialized).toBe("Value\nInfinity");

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(Infinity);
    });

    it("handles -Infinity", () => {
      const serialized = serializeKey(-Infinity, doc);
      expect(serialized).toBe("Value\n-Infinity");

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(-Infinity);
    });

    it("handles NaN", () => {
      const serialized = serializeKey(NaN, doc);
      expect(serialized).toBe("Value\nNaN");

      const deserialized = deserializeKey(serialized, doc);
      expect(Number.isNaN(deserialized)).toBe(true);
    });
  });

  describe("BigInt values", () => {
    it("handles positive BigInt", () => {
      const serialized = serializeKey(123n, doc);
      expect(serialized).toBe("Value\n123n");

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(123n);
    });

    it("handles negative BigInt", () => {
      const serialized = serializeKey(-456n, doc);
      expect(serialized).toBe("Value\n-456n");

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(-456n);
    });

    it("handles very large BigInt", () => {
      const large = 12345678901234567890123456789012345678901234567890n;
      const serialized = serializeKey(large, doc);
      expect(serialized).toBe("Value\n12345678901234567890123456789012345678901234567890n");

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(large);
    });
  });

  describe("empty containers", () => {
    it("handles empty Set", () => {
      const serialized = serializeKey(new Set(), doc);
      expect(serialized).toBe("Set");

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBeInstanceOf(Set);
      expect((deserialized as Set<unknown>).size).toBe(0);
    });

    it("handles empty Array", () => {
      const serialized = serializeKey([], doc);
      expect(serialized).toBe("Array");

      const deserialized = deserializeKey(serialized, doc);
      expect(Array.isArray(deserialized)).toBe(true);
      expect((deserialized as unknown[]).length).toBe(0);
    });
  });

  describe("strings with special characters", () => {
    it("handles string with newline characters", () => {
      const key = "hello\nworld\ntest";
      const serialized = serializeKey(key, doc);
      // JSON.stringify escapes newlines as \n (two chars), not actual newline
      expect(serialized).toBe('Value\n"hello\\nworld\\ntest"');

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(key);
    });

    it("handles string with unicode", () => {
      const key = "こんにちは🎉";
      const serialized = serializeKey(key, doc);

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe(key);
    });

    it("handles string that looks like BigInt", () => {
      // String "123n" should not be confused with BigInt 123n
      const key = "123n";
      const serialized = serializeKey(key, doc);
      expect(serialized).toBe('Value\n"123n"'); // Quoted string, not raw 123n

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe("123n");
      expect(typeof deserialized).toBe("string");
    });

    it("handles string that looks like Infinity", () => {
      const key = "Infinity";
      const serialized = serializeKey(key, doc);
      expect(serialized).toBe('Value\n"Infinity"'); // Quoted string

      const deserialized = deserializeKey(serialized, doc);
      expect(deserialized).toBe("Infinity");
      expect(typeof deserialized).toBe("string");
    });
  });

  describe("containers with special values", () => {
    it("handles Set with Infinity and BigInt", () => {
      const set = new Set([Infinity, 42n, -Infinity]);
      const serialized = serializeKey(set, doc);

      // Values should be sorted: -Infinity, Infinity (numbers), then 42n (bigint by string)
      // Actually canonicalSort sorts by type then value...
      const lines = serialized.split("\n");
      expect(lines[0]).toBe("Set");
      expect(lines).toContain("Infinity");
      expect(lines).toContain("-Infinity");
      expect(lines).toContain("42n");

      const deserialized = deserializeKey(serialized, doc) as Set<unknown>;
      expect(deserialized.has(Infinity)).toBe(true);
      expect(deserialized.has(-Infinity)).toBe(true);
      expect(deserialized.has(42n)).toBe(true);
    });

    it("handles Array with mixed special values", () => {
      const arr = [NaN, 123n, "hello\nworld", null];
      const serialized = serializeKey(arr, doc);

      const lines = serialized.split("\n");
      expect(lines[0]).toBe("Array");
      expect(lines[1]).toBe("NaN");
      expect(lines[2]).toBe("123n");
      expect(lines[3]).toBe('"hello\\nworld"');
      expect(lines[4]).toBe("null");

      const deserialized = deserializeKey(serialized, doc) as unknown[];
      expect(Number.isNaN(deserialized[0])).toBe(true);
      expect(deserialized[1]).toBe(123n);
      expect(deserialized[2]).toBe("hello\nworld");
      expect(deserialized[3]).toBe(null);
    });
  });

  describe("validation of disallowed types", () => {
    it("throws on plain object key", () => {
      const plainObject = { foo: "bar" };
      expect(() => serializeKey(plainObject as any, doc)).toThrow(TypeError);
      expect(() => serializeKey(plainObject as any, doc)).toThrow(/Plain objects are not allowed/);
    });

    it("throws on undefined key", () => {
      expect(() => serializeKey(undefined as any, doc)).toThrow(TypeError);
      expect(() => serializeKey(undefined as any, doc)).toThrow(/undefined is not allowed/);
    });

    it("throws on Symbol key", () => {
      const sym = Symbol("test");
      expect(() => serializeKey(sym as any, doc)).toThrow(TypeError);
      expect(() => serializeKey(sym as any, doc)).toThrow(/Symbols are not allowed/);
    });

    it("throws on function key", () => {
      const fn = () => {};
      expect(() => serializeKey(fn as any, doc)).toThrow(TypeError);
      expect(() => serializeKey(fn as any, doc)).toThrow(/Functions are not allowed/);
    });

    it("throws on Set containing plain object", () => {
      const set = new Set([{ nested: true }]);
      expect(() => serializeKey(set as any, doc)).toThrow(TypeError);
      expect(() => serializeKey(set as any, doc)).toThrow(/Plain objects are not allowed/);
    });

    it("throws on Array containing undefined", () => {
      const arr = [1, undefined, 3];
      expect(() => serializeKey(arr as any, doc)).toThrow(TypeError);
      expect(() => serializeKey(arr as any, doc)).toThrow(/undefined is not allowed/);
    });
  });

  describe("PathMap validation", () => {
    it("throws on plain object key in PathMap", () => {
      const map = new PathMap<any, string>();
      expect(() => map.set({ foo: "bar" }, "value")).toThrow(TypeError);
      expect(() => map.set({ foo: "bar" }, "value")).toThrow(/Plain objects are not allowed/);
    });

    it("throws on Symbol key in PathMap", () => {
      const map = new PathMap<any, string>();
      expect(() => map.set(Symbol("test"), "value")).toThrow(TypeError);
    });

    it("throws on Set containing invalid type in PathMap", () => {
      const map = new PathMap<any, string>();
      expect(() => map.set(new Set([{ bad: true }]), "value")).toThrow(TypeError);
    });

    it("allows valid key types in PathMap", () => {
      const map = new PathMap<any, string>();

      // Primitives
      map.set("string", "v1");
      map.set(123, "v2");
      map.set(true, "v3");
      map.set(null, "v4");
      map.set(456n, "v5");

      // Containers
      map.set(new Set([1, 2, 3]), "v6");
      map.set([1, 2, 3], "v7");

      expect(map.size).toBe(7);
    });
  });
});
