/**
 * Test to verify that Y.UndoManager operations trigger plexus tracking system
 */

import { beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { getInternals, PlexusModel } from "../../PlexusModel.js";
import { createTrackedFunction } from "../../tracking.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("TestModel")
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

  it("entity survives undo (append-only shell) and restores on redo", () => {
    const ref = new TestModel({ name: "first" });
    testPlexus.transact(() => {
      root.ref = ref;
      ref.name = "second";
    });

    testPlexus.undo();

    // Entity shell survives undo — NOT dematerialized
    expect(root.ref).to.eq(null);
    // Entity survives undo — append-only shell
    // UUID is stable
    expect(ref.uuid).to.be.ok;

    testPlexus.redo();

    // Fully restored — same object, same UUID
    expect(root.ref).to.equal(ref);
    expect(ref.name).to.equal("second");
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
    expect(result1).to.equal("initial");
    expect(notificationCount).to.equal(0); // No notifications yet

    // Modify the field
    testPlexus.transact(() => {
      root.name = "modified";
    });

    // Should trigger notification
    expect(notificationCount).to.equal(1);
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
    expect(result1).to.equal("initial");
    expect(notificationCount).to.equal(0);

    // Make a change (this creates an undo stack item)
    root.name = "modified";
    expect(notificationCount).to.equal(1);

    // Re-run tracked function to reset tracking on new value
    const result2 = trackedFn();
    expect(result2).to.equal("modified");

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

    expect(notificationCount).to.equal(2); // Should have been notified about undo

    // Verify the value actually changed
    const result3 = trackedFn();
    expect(result3).to.equal("initial");
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
    expect(notificationCount).to.equal(0);

    // Make a change
    testPlexus.transact(() => {
      root.name = "modified";
    });
    expect(notificationCount).to.equal(1);

    // Re-run to reset tracking
    trackedFn();

    // Undo
    testPlexus.undo();
    expect(notificationCount).to.equal(2);

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

    expect(notificationCount).to.equal(3);

    // Verify the value
    const result = trackedFn();
    expect(result).to.equal("modified");
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

    expect(nameNotifications).to.equal(1);
    expect(countNotifications).to.equal(1);

    // Re-run to reset tracking
    trackedNameFn();
    trackedCountFn();

    // Undo should trigger both
    testPlexus.undo();

    console.log("Name notifications:", nameNotifications);
    console.log("Count notifications:", countNotifications);

    expect(nameNotifications).to.equal(2);
    expect(countNotifications).to.equal(2);
  });
});
