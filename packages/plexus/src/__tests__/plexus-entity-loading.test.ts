import { describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel.js";
import { syncing } from "../decorators.js";
import { initTestPlexus } from "./test-plexus.js";

// Test classes
@syncing
class Item extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor value!: number;
}

@syncing
class Container extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing.child.list
  accessor items!: Item[];
}

describe("Plexus Entity Loading", () => {
  describe("loadEntity", () => {
    it("loads entity by ID after root is ready", () => {
      const item1 = new Item({ name: "item1", value: 100 });
      const item2 = new Item({ name: "item2", value: 200 });
      const container = new Container({
        title: "test",
        items: [item1, item2],
      });

      const { plexus } = initTestPlexus(container);

      // Load entities by their IDs
      const loadedItem1 = plexus.loadEntity<Item>(item1.uuid);
      const loadedItem2 = plexus.loadEntity<Item>(item2.uuid);

      expect(loadedItem1).toBeTruthy();
      expect(loadedItem1?.name).toBe("item1");
      expect(loadedItem1?.value).toBe(100);

      expect(loadedItem2).toBeTruthy();
      expect(loadedItem2?.name).toBe("item2");
      expect(loadedItem2?.value).toBe(200);

      // Should return same instance (cached)
      const loadedAgain = plexus.loadEntity<Item>(item1.uuid);
      expect(loadedAgain).toBe(loadedItem1);
    });

    it("returns null for non-existent entity", () => {
      const container = new Container({
        title: "test",
        items: [],
      });

      const { plexus } = initTestPlexus(container);

      expect(() => {
        plexus.loadEntity("non-existent-id");
      }).toThrow();
    });

    it("loads root entity itself", () => {
      const container = new Container({
        title: "root-container",
        items: [],
      });

      const { plexus, root } = initTestPlexus(container);

      const loadedRoot = plexus.loadEntity<Container>(root.uuid);
      expect(loadedRoot).toBe(root);
      expect(loadedRoot?.title).toBe("root-container");
    });
  });

  describe("hasEntity", () => {
    it("checks entity existence", () => {
      const item = new Item({ name: "test", value: 42 });
      const container = new Container({
        title: "test",
        items: [item],
      });

      const { plexus } = initTestPlexus(container);

      expect(plexus.hasEntity(item.uuid)).toBe(true);
      expect(plexus.hasEntity(container.uuid)).toBe(true);
      expect(plexus.hasEntity("non-existent")).toBe(false);
    });
  });

  describe("getEntityIds", () => {
    it("returns all entity IDs", () => {
      const item1 = new Item({ name: "item1", value: 1 });
      const item2 = new Item({ name: "item2", value: 2 });
      const container = new Container({
        title: "test",
        items: [item1, item2],
      });

      const { plexus } = initTestPlexus(container);

      const allIds = plexus.getEntityIds();
      expect(allIds).toHaveLength(3); // container + 2 items
      expect(allIds).toContain(container.uuid);
      expect(allIds).toContain(item1.uuid);
      expect(allIds).toContain(item2.uuid);
    });

    it("filters by type name", () => {
      const item1 = new Item({ name: "item1", value: 1 });
      const item2 = new Item({ name: "item2", value: 2 });
      const container = new Container({
        title: "test",
        items: [item1, item2],
      });

      const { plexus } = initTestPlexus(container);

      const itemIds = plexus.getEntityIds("Item");
      expect(itemIds).toHaveLength(2);
      expect(itemIds).toContain(item1.uuid);
      expect(itemIds).toContain(item2.uuid);

      const containerIds = plexus.getEntityIds("Container");
      expect(containerIds).toHaveLength(1);
      expect(containerIds).toContain(container.uuid);

      const noneIds = plexus.getEntityIds("NonExistentType");
      expect(noneIds).toHaveLength(0);
    });
  });

  describe("getEntityType", () => {
    it("returns entity type name", () => {
      const item = new Item({ name: "test", value: 42 });
      const container = new Container({
        title: "test",
        items: [item],
      });

      const { plexus } = initTestPlexus(container);

      expect(plexus.getEntityType(item.uuid)).toBe("Item");
      expect(plexus.getEntityType(container.uuid)).toBe("Container");
      expect(plexus.getEntityType("non-existent")).toBeNull();
    });
  });

  describe("Entity loading with modifications", () => {
    it("loads entities that were added after initial load", () => {
      const container = new Container({
        title: "test",
        items: [],
      });

      const { plexus, root: materializedContainer } = initTestPlexus(container);

      // Add new item after materialization
      const newItem = new Item({ name: "added-later", value: 999 });
      materializedContainer.items.push(newItem);

      // Should be able to load the new item
      const loaded = plexus.loadEntity<Item>(newItem.uuid);
      expect(loaded).toBeTruthy();
      expect(loaded?.name).toBe("added-later");
      expect(loaded?.value).toBe(999);
      expect(plexus.hasEntity(newItem.uuid)).toBe(true);
    });

    it("reflects changes to loaded entities", () => {
      const item = new Item({ name: "original", value: 100 });
      const container = new Container({
        title: "test",
        items: [item],
      });

      const { plexus } = initTestPlexus(container);

      const loaded = plexus.loadEntity<Item>(item.uuid);
      expect(loaded?.name).toBe("original");

      // Modify the entity
      loaded!.name = "modified";
      loaded!.value = 200;

      // Load again - should get same instance with changes
      const loadedAgain = plexus.loadEntity<Item>(item.uuid);
      expect(loadedAgain).toBe(loaded);
      expect(loadedAgain?.name).toBe("modified");
      expect(loadedAgain?.value).toBe(200);
    });
  });

  describe("Complex entity hierarchies", () => {
    it("loads nested entities correctly", () => {
      // Create nested structure
      const deepItem = new Item({ name: "deep", value: 1 });
      const midContainer = new Container({
        title: "middle",
        items: [deepItem],
      });

      @syncing
      class NestedContainer extends PlexusModel {
        @syncing
        accessor name!: string;

        @syncing.child.list
        accessor containers!: Container[];
      }

      const root = new NestedContainer({
        name: "root",
        containers: [midContainer],
      });

      const { plexus } = initTestPlexus(root);

      // Should be able to load at any level
      const loadedMid = plexus.loadEntity<Container>(midContainer.uuid);
      expect(loadedMid?.title).toBe("middle");

      const loadedDeep = plexus.loadEntity<Item>(deepItem.uuid);
      expect(loadedDeep?.name).toBe("deep");

      // All should be in the entity list
      const allIds = plexus.getEntityIds();
      expect(allIds).toContain(root.uuid);
      expect(allIds).toContain(midContainer.uuid);
      expect(allIds).toContain(deepItem.uuid);
    });
  });

  describe("Clone and entity loading", () => {
    it("can load cloned entities", () => {
      const item = new Item({ name: "original", value: 100 });
      const container = new Container({
        title: "test",
        items: [item],
      });

      const { plexus, root: materializedContainer } = initTestPlexus(container);

      // Clone an item
      const clonedItem = item.clone();
      clonedItem.name = "cloned";
      materializedContainer.items.push(clonedItem);

      // Should be able to load both original and clone
      const loadedOriginal = plexus.loadEntity<Item>(item.uuid);
      const loadedClone = plexus.loadEntity<Item>(clonedItem.uuid);

      expect(loadedOriginal?.name).toBe("original");
      expect(loadedClone?.name).toBe("cloned");
      expect(loadedOriginal).not.toBe(loadedClone);
    });
  });
});
