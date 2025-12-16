/**
 * Test to verify that Y.UndoManager operations trigger plexus tracking system
 */

import { beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../decorators.js";
import { PlexusModel } from "../PlexusModel.js";
import { createTrackedFunction } from "../tracking.js";
import type { TestPlexus } from "./test-plexus.js";
import { initTestPlexus } from "./test-plexus.js";

@syncing
class TestModel extends PlexusModel {
  @syncing
  accessor name: string = "";
  @syncing
  accessor count: number = 0;
  @syncing
  accessor ref: TestModel | null = null;
}

describe("Y.UndoManager tracking", () => {
  let doc: Y.Doc;
  let testPlexus: TestPlexus<TestModel>;
  let root: TestModel;

  beforeEach(() => {
    const result = initTestPlexus(new TestModel({ name: "initial", count: 0 }));
    doc = result.doc;
    testPlexus = result.plexus;
    root = result.root;
  });

  it("should dematerialize model removed by undo and rematerialize on redo", () => {
    const ref = new TestModel({ name: "first" });
    testPlexus.transact(() => {
      root.ref = ref;
      ref.name = "second";
    });

    testPlexus.undo();

    // Model is dematerialized - root.ref is null
    expect(root.ref).toBe(null);
    // Accessing dematerialized model throws
    expect(ref.__internals__.isDematerialized).toBe(true);
    expect(() => ref.name).toThrow("dematerialized by undo");

    testPlexus.redo();

    // Model is rematerialized
    expect(root.ref).toBe(ref);
    expect(ref.__internals__.isDematerialized).toBeFalsy();
    expect(ref.name).toBe("second");
  });

  it("should track modifications from normal operations", () => {
    let notificationCount = 0;

    const trackedFn = createTrackedFunction(
      () => {
        notificationCount++;
        console.log("✓ Normal modification tracked, count:", notificationCount);
      },
      () => {
        // Access the field to register interest
        return root.name;
      },
    );

    // Initial run
    const result1 = trackedFn();
    expect(result1).toBe("initial");
    expect(notificationCount).toBe(0); // No notifications yet

    // Modify the field
    testPlexus.transact(() => {
      root.name = "modified";
    });

    // Should trigger notification
    expect(notificationCount).toBe(1);
    console.log("✓ Normal modification test PASSED");
  });

  it("should track modifications from UndoManager.undo()", async () => {
    let notificationCount = 0;

    const trackedFn = createTrackedFunction(
      () => {
        notificationCount++;
        console.log("✓ Undo modification tracked, count:", notificationCount);
      },
      () => {
        // Access the field to register interest
        return root.name;
      },
    );

    // Initial run to establish tracking
    const result1 = trackedFn();
    expect(result1).toBe("initial");
    expect(notificationCount).toBe(0);

    // Make a change (this creates an undo stack item)
    root.name = "modified";
    expect(notificationCount).toBe(1);

    // Re-run tracked function to reset tracking on new value
    const result2 = trackedFn();
    expect(result2).toBe("modified");

    // Now undo - this should trigger tracking notification
    console.log("About to undo...");
    testPlexus.undo();

    // The critical assertion: did undo trigger tracking?
    if (notificationCount === 1) {
      console.error("✗ FAILED: Undo did NOT trigger tracking notification!");
      console.error("  Expected notificationCount: 2");
      console.error("  Actual notificationCount:", notificationCount);
    } else {
      console.log("✓ Undo modification test PASSED");
    }

    expect(notificationCount).toBe(2); // Should have been notified about undo

    // Verify the value actually changed
    const result3 = trackedFn();
    expect(result3).toBe("initial");
  });

  it("should track modifications from UndoManager.redo()", () => {
    let notificationCount = 0;

    const trackedFn = createTrackedFunction(
      () => {
        notificationCount++;
        console.log("✓ Redo modification tracked, count:", notificationCount);
      },
      () => {
        return root.name;
      },
    );

    // Initial run
    trackedFn();
    expect(notificationCount).toBe(0);

    // Make a change
    testPlexus.transact(() => {
      root.name = "modified";
    });
    expect(notificationCount).toBe(1);

    // Re-run to reset tracking
    trackedFn();

    // Undo
    testPlexus.undo();
    expect(notificationCount).toBe(2);

    // Re-run to reset tracking
    trackedFn();

    // Now redo - this should also trigger tracking
    console.log("About to redo...");
    testPlexus.redo();

    // The critical assertion
    if (notificationCount === 2) {
      console.error("✗ FAILED: Redo did NOT trigger tracking notification!");
      console.error("  Expected notificationCount: 3");
      console.error("  Actual notificationCount:", notificationCount);
    } else {
      console.log("✓ Redo modification test PASSED");
    }

    expect(notificationCount).toBe(3);

    // Verify the value
    const result = trackedFn();
    expect(result).toBe("modified");
  });

  it("should track modifications from UndoManager for multiple fields", () => {
    let nameNotifications = 0;
    let countNotifications = 0;

    const trackedNameFn = createTrackedFunction(
      () => {
        nameNotifications++;
      },
      () => root.name,
    );

    const trackedCountFn = createTrackedFunction(
      () => {
        countNotifications++;
      },
      () => root.count,
    );

    // Initial runs
    trackedNameFn();
    trackedCountFn();

    // Modify both fields
    testPlexus.transact(() => {
      root.name = "new-name";
      root.count = 42;
    });

    expect(nameNotifications).toBe(1);
    expect(countNotifications).toBe(1);

    // Re-run to reset tracking
    trackedNameFn();
    trackedCountFn();

    // Undo should trigger both
    testPlexus.undo();

    console.log("Name notifications:", nameNotifications);
    console.log("Count notifications:", countNotifications);

    expect(nameNotifications).toBe(2);
    expect(countNotifications).toBe(2);
  });
});
