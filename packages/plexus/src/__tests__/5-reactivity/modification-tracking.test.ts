import { beforeEach, describe, expect, it, vi } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { createTrackedFunction } from "../../tracking.js";

@syncing("TestModel")
class TestModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor count!: number;
}

describe("Simple Data Change Notifications", () => {
  let obj: TestModel;

  beforeEach(() => {
    obj = new TestModel({
      name: "test",
      count: 5,
    });
  });

  it("should notify when accessed data is modified", () => {
    const notifyChanges = vi.fn();

    const trackedFn = createTrackedFunction(notifyChanges, () => {
      return obj.name; // Access obj.name
    });

    // First execution - just captures access, no notification
    expect(trackedFn()).to.equal("test");
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Modify the accessed field - should notify synchronously
    obj.name = "changed";
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(1);
  });

  it("should NOT notify when non-accessed data is modified", () => {
    const notifyChanges = vi.fn();

    const trackedFn = createTrackedFunction(notifyChanges, () => {
      return obj.name; // Only access obj.name
    });

    expect(trackedFn()).to.equal("test");
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Modify a field that was NOT accessed - should not notify
    obj.count = 10;
    expect(notifyChanges).to.have.property("mock").with.property("calls").with.lengthOf(0);
  });

  it("should work with multiple functions", () => {
    const notifyChanges1 = vi.fn();
    const notifyChanges2 = vi.fn();

    const trackedFn1 = createTrackedFunction(notifyChanges1, () => obj.name);
    const trackedFn2 = createTrackedFunction(notifyChanges2, () => obj.name);

    // Both functions access obj.name
    expect(trackedFn1()).to.equal("test");
    expect(trackedFn2()).to.equal("test");

    // Change the shared field - both should be notified
    obj.name = "changed";
    expect(notifyChanges1).to.have.property("mock").with.property("calls").with.lengthOf(1);
    expect(notifyChanges2).to.have.property("mock").with.property("calls").with.lengthOf(1);
  });
});
