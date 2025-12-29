import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Plexus } from "../Plexus.js";
import { PlexusModel } from "../PlexusModel.js";
import type { PlexusMap } from "../proxy-runtime-types.js";
import { syncing } from "../decorators.js";

@syncing
class Variant extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing
class FrameMetadata extends PlexusModel {
  @syncing accessor width!: number;
  @syncing accessor height!: number;
}

@syncing
class Component extends PlexusModel {
  @syncing accessor name!: string;

  // Map with Set<Variant> keys (canonical/unordered)
  @syncing.map accessor framesByCombo!: PlexusMap<Set<Variant>, FrameMetadata>;

  // Map with Variant[] keys (ordered)
  @syncing.map accessor framesByOrderedCombo!: PlexusMap<Variant[], FrameMetadata>;

  // Map with primitive keys
  @syncing.map accessor metadataByName!: PlexusMap<string, FrameMetadata>;

  // Map with PlexusModel keys (direct)
  @syncing.map accessor metadataByVariant!: PlexusMap<Variant, FrameMetadata>;
}

@syncing
class TestSite extends PlexusModel<null> {
  @syncing.child.list accessor components!: Component[];
  @syncing.child.list accessor variants!: Variant[];
}

describe("Map Proxy", () => {
  describe("Basic Map operations", () => {
    it("should support get/set/has/delete with string keys", () => {
      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const metadata = new FrameMetadata({ width: 100, height: 200 });

      // Set
      component.metadataByName.set("default", metadata);
      expect(component.metadataByName.size).toBe(1);

      // Get
      expect(component.metadataByName.get("default")).toBe(metadata);

      // Has
      expect(component.metadataByName.has("default")).toBe(true);
      expect(component.metadataByName.has("nonexistent")).toBe(false);

      // Delete
      expect(component.metadataByName.delete("default")).toBe(true);
      expect(component.metadataByName.size).toBe(0);
      expect(component.metadataByName.delete("nonexistent")).toBe(false);
    });

    it("should support clear", () => {
      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      component.metadataByName.set("a", new FrameMetadata({ width: 1, height: 1 }));
      component.metadataByName.set("b", new FrameMetadata({ width: 2, height: 2 }));
      expect(component.metadataByName.size).toBe(2);

      component.metadataByName.clear();
      expect(component.metadataByName.size).toBe(0);
    });

    it("should support iteration", () => {
      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByName.set("first", meta1);
      component.metadataByName.set("second", meta2);

      // keys()
      const keys = [...component.metadataByName.keys()];
      expect(keys).toContain("first");
      expect(keys).toContain("second");

      // values()
      const values = [...component.metadataByName.values()];
      expect(values).toContain(meta1);
      expect(values).toContain(meta2);

      // entries()
      const entries = [...component.metadataByName.entries()];
      expect(entries.length).toBe(2);

      // forEach
      const collected: string[] = [];
      component.metadataByName.forEach((val, key) => {
        collected.push(key as string);
      });
      expect(collected).toContain("first");
      expect(collected).toContain("second");
    });
  });

  describe("Set keys (canonical/unordered)", () => {
    it("should treat Set keys as unordered - same elements, different order = same key", () => {
      const v1 = new Variant({ name: "Variant1" });
      const v2 = new Variant({ name: "Variant2" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const metadata = new FrameMetadata({ width: 100, height: 200 });

      // Set with key [v1, v2]
      component.framesByCombo.set(new Set([v1, v2]), metadata);
      expect(component.framesByCombo.size).toBe(1);

      // Get with key [v2, v1] - should find the same entry!
      const retrieved = component.framesByCombo.get(new Set([v2, v1]));
      expect(retrieved).toBe(metadata);

      // Has with different order
      expect(component.framesByCombo.has(new Set([v2, v1]))).toBe(true);
    });

    it("should distinguish different sets", () => {
      const v1 = new Variant({ name: "Variant1" });
      const v2 = new Variant({ name: "Variant2" });
      const v3 = new Variant({ name: "Variant3" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.framesByCombo.set(new Set([v1, v2]), meta1);
      component.framesByCombo.set(new Set([v1, v3]), meta2);

      expect(component.framesByCombo.size).toBe(2);
      expect(component.framesByCombo.get(new Set([v1, v2]))).toBe(meta1);
      expect(component.framesByCombo.get(new Set([v1, v3]))).toBe(meta2);
    });
  });

  describe("Array keys (ordered)", () => {
    it("should preserve array order - different order = different key", () => {
      const v1 = new Variant({ name: "Variant1" });
      const v2 = new Variant({ name: "Variant2" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.framesByOrderedCombo.set([v1, v2], meta1);
      component.framesByOrderedCombo.set([v2, v1], meta2);

      // Different order = different entries
      expect(component.framesByOrderedCombo.size).toBe(2);
    });
  });

  describe("PlexusModel keys (direct)", () => {
    it("should support PlexusModel as direct map key", () => {
      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByVariant.set(v1, meta1);
      component.metadataByVariant.set(v2, meta2);

      expect(component.metadataByVariant.size).toBe(2);
      expect(component.metadataByVariant.get(v1)).toBe(meta1);
      expect(component.metadataByVariant.get(v2)).toBe(meta2);
    });

    it("should use model identity - same model = same key", () => {
      const v1 = new Variant({ name: "Hover" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByVariant.set(v1, meta1);
      component.metadataByVariant.set(v1, meta2); // Same key, update value

      expect(component.metadataByVariant.size).toBe(1);
      expect(component.metadataByVariant.get(v1)).toBe(meta2);
    });

    it("should distinguish different models with same data", () => {
      // Two variants with the same name but different identity
      const v1 = new Variant({ name: "Same" });
      const v2 = new Variant({ name: "Same" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      const meta1 = new FrameMetadata({ width: 100, height: 100 });
      const meta2 = new FrameMetadata({ width: 200, height: 200 });

      component.metadataByVariant.set(v1, meta1);
      component.metadataByVariant.set(v2, meta2);

      // Different model instances = different keys
      expect(component.metadataByVariant.size).toBe(2);
      expect(component.metadataByVariant.get(v1)).toBe(meta1);
      expect(component.metadataByVariant.get(v2)).toBe(meta2);
    });

    it("should support delete with model key", () => {
      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      component.metadataByVariant.set(v1, new FrameMetadata({ width: 100, height: 100 }));
      component.metadataByVariant.set(v2, new FrameMetadata({ width: 200, height: 200 }));

      expect(component.metadataByVariant.delete(v1)).toBe(true);
      expect(component.metadataByVariant.size).toBe(1);
      expect(component.metadataByVariant.has(v1)).toBe(false);
      expect(component.metadataByVariant.has(v2)).toBe(true);
    });

    it("should iterate over model keys", () => {
      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });

      const component = new Component({
        name: "Test",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });

      component.metadataByVariant.set(v1, new FrameMetadata({ width: 100, height: 100 }));
      component.metadataByVariant.set(v2, new FrameMetadata({ width: 200, height: 200 }));

      const keys = [...component.metadataByVariant.keys()];
      expect(keys).toHaveLength(2);
      expect(keys).toContain(v1);
      expect(keys).toContain(v2);
    });
  });

  describe("Persistence via Plexus", () => {
    it("should persist Map data across document sync", () => {
      const doc1 = new Y.Doc();
      const site1 = new TestSite({ components: [], variants: [] });
      const plexus1 = Plexus.bootstrap(site1, "test-site", doc1);

      const v1 = new Variant({ name: "Hover" });
      const v2 = new Variant({ name: "Active" });
      site1.variants.push(v1, v2);

      const component = new Component({
        name: "Button",
        framesByCombo: new Map(),
        framesByOrderedCombo: new Map(),
        metadataByName: new Map(),
        metadataByVariant: new Map(),
      });
      site1.components.push(component);

      // Add map entries
      component.metadataByName.set("default", new FrameMetadata({ width: 400, height: 300 }));
      component.framesByCombo.set(new Set([v1, v2]), new FrameMetadata({ width: 500, height: 400 }));

      // Sync to another doc
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
      const plexus2 = Plexus.connect(doc2) as Plexus<TestSite>;

      // Verify data was persisted
      const site2 = plexus2.root;
      const comp2 = site2.components[0];

      expect(comp2.metadataByName.size).toBe(1);
      expect(comp2.metadataByName.get("default")?.width).toBe(400);

      // Note: Set keys are serialized to UUIDs, so we need to reconstruct
      // the lookup using the synced variant objects
      const v1Synced = site2.variants[0];
      const v2Synced = site2.variants[1];
      expect(comp2.framesByCombo.size).toBe(1);

      // The key lookup works with the synced variants
      const combo = comp2.framesByCombo.get(new Set([v1Synced, v2Synced]));
      expect(combo?.width).toBe(500);
    });
  });
});
