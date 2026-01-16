/**
 * Tracking edge cases - tests for potential gaps in modification notifications
 *
 * These tests document expected behavior for edge cases in the tracking system.
 * Some tests may fail initially to identify bugs.
 */

import { describe, expect, it, vi } from "vitest";
import { PlexusModel } from "../../PlexusModel.js";
import { syncing } from "../../decorators.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";
import { createTrackedFunction } from "../../tracking.js";

@syncing
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing
class Container extends PlexusModel<null> {
  @syncing.map accessor map: Map<string, string> = new Map();
  @syncing.child.list accessor items: Item[] = [];
  @syncing.record accessor record: Record<string, string> = {};
}

describe("Tracking Edge Cases", () => {
  describe("Map.values() tracking", () => {
    it("notifies values() subscribers when existing value is updated", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "initial");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...root.map.values()]);
      tracked();

      // Modifying existing key's value should notify values() subscribers
      root.map.set("key", "updated");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies values() subscribers when new key-value added", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("existing", "value");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...root.map.values()]);
      tracked();

      root.map.set("new", "newValue");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies values() subscribers when value is deleted", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "value");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => [...root.map.values()]);
      tracked();

      root.map.delete("key");
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("Array length tracking with index assignment", () => {
    it("notifies length subscribers when array extended via index assignment", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.items.length);
      tracked();

      // Extending array via index assignment should notify length subscribers
      root.items[0] = new Item({ name: "first" });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies length subscribers when array extended with gaps", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.items.length);
      tracked();

      // Creating sparse array via index should notify
      root.items[5] = new Item({ name: "at-five" });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does NOT notify length subscribers when replacing existing element", () => {
      const { root } = initTestPlexus(new Container());
      root.items.push(new Item({ name: "initial" }));

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.items.length);
      tracked();

      // Replacing existing element should NOT notify length (length unchanged)
      root.items[0] = new Item({ name: "replaced" });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("Record enumeration tracking", () => {
    it("notifies Object.keys() subscribers when key added", () => {
      const { root } = initTestPlexus(new Container());
      root.record["existing"] = "value";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.keys(root.record));
      tracked();

      root.record["new"] = "newValue";
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies Object.values() subscribers when value changed", () => {
      const { root } = initTestPlexus(new Container());
      root.record["key"] = "initial";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.values(root.record));
      tracked();

      root.record["key"] = "updated";
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies Object.keys() subscribers when key removed", () => {
      const { root } = initTestPlexus(new Container());
      root.record["key"] = "value";

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => Object.keys(root.record));
      tracked();

      delete root.record["key"];
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("Map.get() specific key tracking", () => {
    it("notifies get(key) subscribers when that specific key changes", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("tracked", "initial");
      root.map.set("other", "otherValue");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.get("tracked"));
      tracked();

      // Only the tracked key should trigger notification
      root.map.set("tracked", "updated");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does NOT notify get(key) subscribers when different key changes", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("tracked", "initial");
      root.map.set("other", "otherValue");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.get("tracked"));
      tracked();

      // Changing a different key should NOT notify
      root.map.set("other", "updated");
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("Map.has() tracking", () => {
    it("notifies has() subscribers when key is added", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.has("key"));
      tracked();

      root.map.set("key", "value");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies has() subscribers when key is deleted", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "value");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.has("key"));
      tracked();

      root.map.delete("key");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does NOT notify has() subscribers when value changes (key still exists)", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "initial");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.has("key"));
      tracked();

      // Value change should NOT notify has() (key presence unchanged)
      root.map.set("key", "updated");
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("Map.size tracking", () => {
    it("notifies size subscribers when key is added", () => {
      const { root } = initTestPlexus(new Container());

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.size);
      tracked();

      root.map.set("key", "value");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies size subscribers when key is deleted", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "value");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.size);
      tracked();

      root.map.delete("key");
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does NOT notify size subscribers when value changes (size unchanged)", () => {
      const { root } = initTestPlexus(new Container());
      root.map.set("key", "initial");

      const notify = vi.fn();
      const tracked = createTrackedFunction(notify, () => root.map.size);
      tracked();

      // Value change should NOT notify size (size unchanged)
      root.map.set("key", "updated");
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
