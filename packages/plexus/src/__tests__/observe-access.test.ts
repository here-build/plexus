/**
 * Tests for the createTrackedFunction higher-order function
 */

import { describe, expect, it, vi } from "vitest";
import { buildModelClass, createTrackedFunction, ModelType } from "../index.js";

type TestModelType = ModelType<
  {
    name: string;
    count: number;
    active: boolean;
    items: unknown[];
    map: Record<string, unknown>;
  },
  "TestModel"
>;

const TestModel = buildModelClass<TestModelType>("TestModel", {
  name: "val",
  count: "val",
  active: "val",
  items: "list",
  map: "map"
});

describe("createTrackedFunction HOF", () => {
  it("should not notify on first execution", () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true,
      items: [],
      map: {}
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (suffix: string) => {
      return obj.name + suffix;
    });

    const result = trackedFn(" world");
    expect(result).toBe("test world");
    expect(notifyChanges).not.toHaveBeenCalled();
  });

  it("should not notify when accessing same fields", () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true,
      items: [],
      map: {}
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (suffix: string) => {
      return obj.name + suffix;
    });

    // First execution
    trackedFn(" world");
    expect(notifyChanges).not.toHaveBeenCalled();

    // Second execution - same field access
    trackedFn(" again");
    expect(notifyChanges).not.toHaveBeenCalled();
  });

  it("should notify when accessing different fields", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true,
      items: [],
      map: {}
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (useCount: boolean) => {
      if (useCount) {
        return obj.count.toString();
      } else {
        return obj.name;
      }
    });

    // First execution - access name
    let result1 = trackedFn(false);
    expect(result1).toBe("test");
    expect(notifyChanges).not.toHaveBeenCalled();

    // Second execution - access count (different field)
    let result2 = trackedFn(true);
    expect(result2).toBe("42");

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should notify when accessing additional fields", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true,
      items: [],
      map: {}
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (includeCount: boolean) => {
      let result = obj.name;
      if (includeCount) {
        result += " " + obj.count;
      }
      return result;
    });

    // First execution - access only name
    let result1 = trackedFn(false);
    expect(result1).toBe("test");
    expect(notifyChanges).not.toHaveBeenCalled();

    // Second execution - access name + count (additional field)
    let result2 = trackedFn(true);
    expect(result2).toBe("test 42");

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should notify when accessing fewer fields", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true,
      items: [],
      map: {}
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (includeCount: boolean) => {
      let result = obj.name;
      if (includeCount) {
        result += " " + obj.count;
      }
      return result;
    });

    // First execution - access name + count
    let result1 = trackedFn(true);
    expect(result1).toBe("test 42");
    expect(notifyChanges).not.toHaveBeenCalled();

    // Second execution - access only name (fewer fields)
    let result2 = trackedFn(false);
    expect(result2).toBe("test");

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should handle complex access patterns with maps and arrays", async () => {
    const childObj = new TestModel({
      name: "child",
      count: 1,
      active: true,
      items: [],
      map: {}
    });

    const obj = new TestModel({
      name: "parent",
      count: 0,
      active: true,
      items: [childObj],
      map: { child: childObj }
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (useMap: boolean) => {
      if (useMap) {
        return Object.keys(obj.map);
      } else {
        return obj.items.length;
      }
    });

    // First execution - access items.length
    let result1 = trackedFn(false);
    expect(result1).toBe(1);
    expect(notifyChanges).not.toHaveBeenCalled();

    // Second execution - access map keys (different access pattern)
    let result2 = trackedFn(true);
    expect(result2).toEqual(["child"]);

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should work with functions that take multiple arguments", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true,
      items: [],
      map: {}
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (prefix: string, suffix: string, useCount: boolean) => {
      if (useCount) {
        return prefix + obj.count + suffix;
      } else {
        return prefix + obj.name + suffix;
      }
    });

    // First execution - access name
    let result1 = trackedFn("Hello ", "!", false);
    expect(result1).toBe("Hello test!");
    expect(notifyChanges).not.toHaveBeenCalled();

    // Second execution - access count (different field)
    let result2 = trackedFn("Number ", "!", true);
    expect(result2).toBe("Number 42!");

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(1);

    // Third execution - access name again (back to original pattern)
    let result3 = trackedFn("Hi ", "!", false);
    expect(result3).toBe("Hi test!");

    // Wait for second batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(2);
  });
});
