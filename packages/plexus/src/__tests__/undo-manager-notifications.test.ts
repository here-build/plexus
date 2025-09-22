/**
 * Test that UndoManager properly triggers observer notifications
 */

import * as Y from "yjs";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { initTestPlexus } from "./test-plexus";
import { createTrackedFunction } from "../tracking";

// Test models
@syncing
class ChildModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;

  constructor(props) {
    super(props);
  }
}

@syncing
class ParentModel extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing.child
  accessor primaryChild!: ChildModel | null;

  @syncing.child.list
  accessor children!: ChildModel[];

  @syncing.child.map
  accessor namedChildren!: Record<string, ChildModel>;

  constructor(props) {
    super(props);
  }
}

@syncing
class RootModel extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.child
  accessor parent!: ParentModel | null;

  constructor(props) {
    super(props);
  }
}

describe("UndoManager Observer Notifications", () => {
  let doc: Y.Doc;
  let root: RootModel;
  let plexus: any;

  beforeEach(async () => {
    // Initialize test data
    const ephemeralRoot = new RootModel({
      name: "Root",
      parent: new ParentModel({
        title: "Parent",
        primaryChild: new ChildModel({ name: "Child1", value: 1 }),
        children: [
          new ChildModel({ name: "Child2", value: 2 }),
          new ChildModel({ name: "Child3", value: 3 })
        ],
        namedChildren: {
          alpha: new ChildModel({ name: "Alpha", value: 10 }),
          beta: new ChildModel({ name: "Beta", value: 20 })
        }
      })
    });

    const result = await initTestPlexus<RootModel>(ephemeralRoot);
    doc = result.doc;
    root = result.root;
    plexus = result.plexus;
  });

  describe("Val field changes", () => {
    it("should notify observers when val field is undone", async () => {
      plexus.undoManager.stopCapturing();
      const nameObserver = vi.fn();
      root.name = "Modified";
      let fn = createTrackedFunction(() => {
        console.log("tracked fn")
        nameObserver();
      }, () => root.name);
      fn();
      expect(nameObserver).not.toHaveBeenCalled();
      plexus.undoManager.undo();
      expect(nameObserver).toHaveBeenCalledOnce()
      expect(fn()).toEqual("Root");
      expect(nameObserver).toHaveBeenCalledOnce();
      console.log("modifying");
      root.name = "Modified2";
      console.log("after modifying");
      expect(nameObserver).toHaveBeenCalledTimes(2);
    });

    it("should notify observers when val field is redone", () => {
      const nameObserver = vi.fn();
      const fn = createTrackedFunction(nameObserver, () => root.name);

      fn(); // Initial read
      expect(nameObserver).not.toHaveBeenCalled();
      expect(root.name).toBe("Root");

      // Make a change
      root.name = "Modified";
      expect(nameObserver).toHaveBeenCalled();
      nameObserver.mockClear();

      fn(); // Re-register after notification

      // Undo then redo
      plexus.undoManager.undo();
      expect(nameObserver).toHaveBeenCalled();
      nameObserver.mockClear();
      expect(root.name).toBe("Root");

      fn(); // Re-register after notification

      plexus.undoManager.redo();
      expect(nameObserver).toHaveBeenCalled();
      nameObserver.mockClear();
      expect(root.name).toBe("Modified");
    });
  });

  describe("Child-val field changes", () => {
    it("should notify observers when child-val field is undone", () => {
      const childObserver = vi.fn();
      const fn = createTrackedFunction(() => {
        childObserver(root.parent?.primaryChild);
      }, () => root.parent?.primaryChild);

      fn(); // Initial read
      expect(childObserver).not.toHaveBeenCalled();

      const originalChild = root.parent!.primaryChild;
      const newChild = new ChildModel({ name: "NewChild", value: 99 });

      // Change child
      root.parent!.primaryChild = newChild;
      expect(childObserver).toHaveBeenCalledWith(newChild);
      expect(root.parent!.primaryChild).toBe(newChild);
      childObserver.mockClear();

      fn(); // Re-register after notification

      // Undo
      console.log("Before undo, primaryChild:", root.parent!.primaryChild);
      plexus.undoManager.undo();
      console.log("After undo, primaryChild:", root.parent!.primaryChild);

      // Should restore original child
      expect(childObserver).toHaveBeenCalledWith(originalChild);
      expect(root.parent!.primaryChild).toBe(originalChild);
    });

    it("should notify parent tracking when child-val is set to null", () => {
      const parentObserver = vi.fn();
      const child = root.parent!.primaryChild!;

      const fn = createTrackedFunction(() => {
        parentObserver(child.parent);
      }, () => child.parent);

      fn(); // Initial read
      expect(parentObserver).not.toHaveBeenCalled();
      expect(child.parent).toBe(root.parent);

      // Set child to null
      root.parent!.primaryChild = null;
      expect(parentObserver).toHaveBeenCalledWith(null);
      parentObserver.mockClear();

      fn(); // Re-register after notification

      // Undo
      plexus.undoManager.undo();

      // Should restore parent relationship
      expect(parentObserver).toHaveBeenCalledWith(root.parent);
      expect(child.parent).toBe(root.parent);
    });
  });

  describe("Parent tracking", () => {
    it("should notify when parent changes on undo", () => {
      const child = root.parent!.children[0];
      const parentObserver = vi.fn();

      const fn = createTrackedFunction(() => {
        parentObserver(child.parent);
      }, () => child.parent);

      fn(); // Initial read
      expect(parentObserver).not.toHaveBeenCalled();
      expect(child.parent).toBe(root.parent);

      // Remove from parent (changes parent to null)
      root.parent!.children.splice(0, 1);
      expect(parentObserver).toHaveBeenCalledOnce();
      expect(parentObserver).toHaveBeenCalledWith(null);
      expect(child.parent).toBe(null);
      parentObserver.mockClear();

      // Re-register for tracking after the notification
      fn();

      // Undo
      plexus.undoManager.undo();

      // Should restore parent
      expect(parentObserver).toHaveBeenCalledOnce();
      expect(parentObserver).toHaveBeenCalledWith(root.parent);
      expect(child.parent).toBe(root.parent);
    });

    it("should notify when moved to different field of same parent", () => {
      const child = root.parent!.children[0];
      const parentObserver = vi.fn();

      // Track any change to parent relationship
      const fn = createTrackedFunction(() => {
        parentObserver(child.parent);
      }, () => child.parent);

      fn(); // Initial read
      expect(parentObserver).not.toHaveBeenCalled();

      // Move from children array to primaryChild
      root.parent!.children.splice(0, 1);
      expect(parentObserver).toHaveBeenCalledOnce();
      expect(parentObserver).toHaveBeenCalledWith(null); // Temporarily orphaned
      parentObserver.mockClear();

      fn(); // Re-register after notification

      root.parent!.primaryChild = child;
      expect(parentObserver).toHaveBeenCalledOnce();
      expect(parentObserver).toHaveBeenCalledWith(root.parent); // Re-adopted
      parentObserver.mockClear();

      fn(); // Re-register after notification

      // Undo the move
      plexus.undoManager.undo();

      // Should notify about parent change (even though parent object is same)
      expect(parentObserver).toHaveBeenCalled();
      expect(child.parent).toBe(root.parent);
      expect(root.parent!.children).toContain(child);
      expect(root.parent!.primaryChild).not.toBe(child);
    });

    it("should notify when parent metadata changes", () => {
      const child = root.parent!.namedChildren.alpha;
      const parentObserver = vi.fn();

      const fn = createTrackedFunction(() => {
        parentObserver(child.parent);
      }, () => child.parent);

      fn(); // Initial read
      expect(parentObserver).not.toHaveBeenCalled();
      expect(child.parent).toBe(root.parent);

      // Move from 'alpha' to 'gamma' in same parent
      delete root.parent!.namedChildren.alpha;
      expect(parentObserver).toHaveBeenCalledOnce();
      expect(parentObserver).toHaveBeenCalledWith(null); // Temporarily orphaned
      parentObserver.mockClear();

      fn(); // Re-register after notification

      root.parent!.namedChildren.gamma = child;
      expect(parentObserver).toHaveBeenCalledOnce();
      expect(parentObserver).toHaveBeenCalledWith(root.parent); // Re-adopted with new key
      parentObserver.mockClear();

      fn(); // Re-register after notification

      // Undo
      plexus.undoManager.undo();

      // Should notify about metadata change
      expect(parentObserver).toHaveBeenCalled();
      expect(child.parent).toBe(root.parent);
      expect(root.parent!.namedChildren.alpha).toBe(child);
      expect(root.parent!.namedChildren.gamma).toBeUndefined();
    });
  });

  describe("Collections (should track content changes)", () => {
    it("should track array changes on undo/redo", () => {
      const arrayObserver = vi.fn();
      const fn = createTrackedFunction(arrayObserver, () => root.parent!.children.length);

      fn(); // Initial read
      expect(arrayObserver).not.toHaveBeenCalled();
      const initialLength = root.parent!.children.length;

      // Add a child
      root.parent!.children.push(new ChildModel({ name: "NewChild", value: 100 }));
      expect(arrayObserver).toHaveBeenCalled();
      arrayObserver.mockClear();

      fn();
      expect(arrayObserver).not.toHaveBeenCalled();
      expect(root.parent!.children.length).toBe(initialLength + 1);

      // Undo
      plexus.undoManager.undo();
      expect(arrayObserver).toHaveBeenCalled();
      arrayObserver.mockClear();

      fn();
      expect(arrayObserver).not.toHaveBeenCalled();
      expect(root.parent!.children.length).toBe(initialLength);

      // Redo
      plexus.undoManager.redo();
      expect(arrayObserver).toHaveBeenCalled();
      arrayObserver.mockClear();

      fn();
      expect(arrayObserver).not.toHaveBeenCalled();
      expect(root.parent!.children.length).toBe(initialLength + 1);
    });

    it("should track record/map changes on undo/redo", () => {
      const recordObserver = vi.fn();
      const fn = createTrackedFunction(recordObserver, () => Object.keys(root.parent!.namedChildren).length);

      fn(); // Initial read
      expect(recordObserver).not.toHaveBeenCalled();
      const initialKeys = Object.keys(root.parent!.namedChildren).length;

      // Add a named child
      root.parent!.namedChildren.gamma = new ChildModel({ name: "Gamma", value: 30 });
      expect(recordObserver).toHaveBeenCalled();
      recordObserver.mockClear();

      fn();
      expect(recordObserver).not.toHaveBeenCalled();
      expect(Object.keys(root.parent!.namedChildren).length).toBe(initialKeys + 1);

      // Undo
      plexus.undoManager.undo();
      expect(recordObserver).toHaveBeenCalled();
      recordObserver.mockClear();

      fn();
      expect(recordObserver).not.toHaveBeenCalled();
      expect(Object.keys(root.parent!.namedChildren).length).toBe(initialKeys);
      expect(root.parent!.namedChildren.gamma).toBeUndefined();

      // Redo
      plexus.undoManager.redo();
      expect(recordObserver).toHaveBeenCalled();
      recordObserver.mockClear();

      fn();
      expect(recordObserver).not.toHaveBeenCalled();
      expect(Object.keys(root.parent!.namedChildren).length).toBe(initialKeys + 1);
      expect(root.parent!.namedChildren.gamma).toBeDefined();
    });

    it("should track set changes on undo/redo", () => {
      // First let's add a set field to our test model
      // For this test, we'll simulate with the children array as a pseudo-set
      const setObserver = vi.fn();
      const children = root.parent!.children;
      const fn = createTrackedFunction(setObserver, () => {
        // Track unique children by name
        const uniqueNames = new Set(children.map(c => c.name));
        return uniqueNames.size;
      });

      fn(); // Initial read
      expect(setObserver).not.toHaveBeenCalled();
      const initialSize = new Set(children.map(c => c.name)).size;

      // Add a child with unique name
      children.push(new ChildModel({ name: "UniqueChild", value: 999 }));
      expect(setObserver).toHaveBeenCalled();
      setObserver.mockClear();

      fn();
      expect(setObserver).not.toHaveBeenCalled();
      expect(new Set(children.map(c => c.name)).size).toBe(initialSize + 1);

      // Undo
      plexus.undoManager.undo();
      expect(setObserver).toHaveBeenCalled();
      setObserver.mockClear();

      fn();
      expect(setObserver).not.toHaveBeenCalled();
      expect(new Set(children.map(c => c.name)).size).toBe(initialSize);

      // Redo
      plexus.undoManager.redo();
      expect(setObserver).toHaveBeenCalled();
      setObserver.mockClear();

      fn();
      expect(setObserver).not.toHaveBeenCalled();
      expect(new Set(children.map(c => c.name)).size).toBe(initialSize + 1);
    });
  });

  describe("Multiple changes in single transaction", () => {
    it("should batch notifications for multiple field changes", () => {
      const nameObserver = vi.fn();
      const titleObserver = vi.fn();

      const fnName = createTrackedFunction(() => {
        nameObserver(root.name);
      }, () => root.name);

      const fnTitle = createTrackedFunction(() => {
        titleObserver(root.parent?.title);
      }, () => root.parent?.title);

      fnName(); // Initial read
      fnTitle(); // Initial read
      expect(nameObserver).not.toHaveBeenCalled();
      expect(titleObserver).not.toHaveBeenCalled();

      // Make multiple changes in one transaction
      doc.transact(() => {
        root.name = "BatchedName";
        root.parent!.title = "BatchedTitle";
      });

      expect(nameObserver).toHaveBeenCalledWith("BatchedName");
      expect(titleObserver).toHaveBeenCalledWith("BatchedTitle");

      nameObserver.mockClear();
      titleObserver.mockClear();

      fnName(); // Re-register after notification
      fnTitle(); // Re-register after notification

      // Undo should revert both
      plexus.undoManager.undo();

      expect(nameObserver).toHaveBeenCalledWith("Root");
      expect(titleObserver).toHaveBeenCalledWith("Parent");
    });
  });

  describe("Edge cases", () => {
    it("should handle rapid undo/redo cycles", () => {
      const observer = vi.fn();

      const fn = createTrackedFunction(() => {
        observer(root.name);
      }, () => root.name);

      fn(); // Initial read
      expect(observer).not.toHaveBeenCalled();

      // Make change
      root.name = "Changed";
      expect(observer).toHaveBeenCalledWith("Changed");
      observer.mockClear();

      // Rapid undo/redo
      for (let i = 0; i < 5; i++) {
        fn(); // Re-register before undo

        plexus.undoManager.undo();
        expect(observer).toHaveBeenCalledWith("Root");
        expect(root.name).toBe("Root");
        observer.mockClear();

        fn(); // Re-register before redo

        plexus.undoManager.redo();
        expect(observer).toHaveBeenCalledWith("Changed");
        expect(root.name).toBe("Changed");
        observer.mockClear();
      }

      // Should have notified correctly (10 times total - 5 undos + 5 redos)
      // Already verified inline with expect calls above
    });
  });
});
