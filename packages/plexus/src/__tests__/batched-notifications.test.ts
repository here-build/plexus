/**
 * Tests for batched notifications in createTrackedFunction
 */

import { describe, expect, it, vi } from "vitest";
import { buildModelClass, createTrackedFunction, ModelType } from "../index.js";

interface TestModelData {
  name: string;
  count: number;
  active: boolean;
}

type TestModelType = ModelType<
  {
    name: string;
    count: number;
    active: boolean;
  },
  "TestModel"
>;

const TestModel = buildModelClass<TestModelType>("TestModel", {
  name: "val",
  count: "val",
  active: "val"
});

describe("Batched Notifications", () => {
  it("should batch multiple notifications into a single call", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true
    });

    const notifyChanges = vi.fn();

    // Create two tracked functions that will both detect changes
    const trackedFn1 = createTrackedFunction(notifyChanges, (useCount: boolean) => {
      return useCount ? obj.count : obj.name;
    });

    const trackedFn2 = createTrackedFunction(notifyChanges, (useActive: boolean) => {
      return useActive ? obj.active : obj.name;
    });

    // First calls - no notifications
    trackedFn1(false); // accesses name
    trackedFn2(false); // accesses name
    expect(notifyChanges).not.toHaveBeenCalled();

    // Wait for any pending microtasks
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).not.toHaveBeenCalled();

    // Change access patterns simultaneously
    trackedFn1(true); // now accesses count (change!)
    trackedFn2(true); // now accesses active (change!)

    // Should not be called immediately
    expect(notifyChanges).not.toHaveBeenCalled();

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Should be called exactly once, even though two functions detected changes
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should handle same callback used by multiple functions", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true
    });

    const sharedNotifyChanges = vi.fn();

    // Create multiple tracked functions sharing the same callback
    const trackedFn1 = createTrackedFunction(sharedNotifyChanges, (field: "name" | "count") => {
      return field === "name" ? obj.name : obj.count;
    });

    const trackedFn2 = createTrackedFunction(sharedNotifyChanges, (field: "name" | "active") => {
      return field === "name" ? obj.name : obj.active;
    });

    const trackedFn3 = createTrackedFunction(sharedNotifyChanges, () => obj.name);

    // First calls
    trackedFn1("name");
    trackedFn2("name");
    trackedFn3();

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(sharedNotifyChanges).not.toHaveBeenCalled();

    // All functions change their access patterns at once
    trackedFn1("count"); // changes from name to count
    trackedFn2("active"); // changes from name to active
    // trackedFn3 unchanged - still accesses name

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Even though the same callback was triggered by 2 functions,
    // it should only be called once due to Set deduplication
    expect(sharedNotifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should handle rapid successive changes", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (field: "name" | "count" | "active") => {
      switch (field) {
        case "name":
          return obj.name;
        case "count":
          return obj.count;
        case "active":
          return obj.active;
      }
    });

    // First call
    trackedFn("name");

    // Rapid changes within the same microtask
    trackedFn("count"); // change 1
    trackedFn("active"); // change 2
    trackedFn("name"); // change 3
    trackedFn("count"); // change 4

    expect(notifyChanges).not.toHaveBeenCalled();

    // Wait for batched notification
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Should still only be called once despite 4 access pattern changes
    expect(notifyChanges).toHaveBeenCalledTimes(1);
  });

  it("should handle notifications across multiple microtask cycles", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true
    });

    const notifyChanges = vi.fn();
    const trackedFn = createTrackedFunction(notifyChanges, (field: "name" | "count") => {
      return field === "name" ? obj.name : obj.count;
    });

    // First call
    trackedFn("name");

    // First change
    trackedFn("count");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(1);

    // Second change in new microtask cycle
    trackedFn("name");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(2);

    // Third change
    trackedFn("count");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notifyChanges).toHaveBeenCalledTimes(3);
  });

  it("should work with different callbacks correctly", async () => {
    const obj = new TestModel({
      name: "test",
      count: 42,
      active: true
    });

    const notifyChanges1 = vi.fn();
    const notifyChanges2 = vi.fn();

    const trackedFn1 = createTrackedFunction(notifyChanges1, (useCount: boolean) => {
      return useCount ? obj.count : obj.name;
    });

    const trackedFn2 = createTrackedFunction(notifyChanges2, (useActive: boolean) => {
      return useActive ? obj.active : obj.name;
    });

    // First calls
    trackedFn1(false); // name
    trackedFn2(false); // name

    // Changes
    trackedFn1(true); // count
    trackedFn2(true); // active

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Both callbacks should be called once each
    expect(notifyChanges1).toHaveBeenCalledTimes(1);
    expect(notifyChanges2).toHaveBeenCalledTimes(1);
  });
});
