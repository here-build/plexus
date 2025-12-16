/**
 * Tests for dependency system - loading external packages as read-only snapshots.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../decorators.js";
import { PlexusModel } from "../PlexusModel.js";
import { initTestPlexus } from "./test-plexus.js";

@syncing
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing
class Container extends PlexusModel {
  @syncing accessor name: string = "";

  @syncing.child accessor item: Item | null = null;

  @syncing.child.list accessor items: Item[] = [];
}

@syncing
class Root extends PlexusModel<null> {
  dependencies?: Record<string, Root>;

  @syncing.child.list accessor containers: Container[] = [];

  @syncing.child.list accessor items: Item[] = [];
}

function createDependencyDoc(documentId: string, setup: (plexus: ReturnType<typeof initTestPlexus<Root>>) => void) {
  const { doc, plexus, root } = initTestPlexus(new Root({ containers: [], items: [] }), {}, documentId);

  plexus.transact(() => {
    setup({ doc, plexus, root });
  });

  return Y.encodeStateAsUpdate(doc);
}

describe("Dependency system", () => {
  describe("Basic dependency loading", () => {
    it("should load a simple dependency with flat items", () => {
      const depVector = createDependencyDoc("pkg-1", ({ root }) => {
        root.items.push(new Item({ name: "item-a" }));
        root.items.push(new Item({ name: "item-b" }));
      });

      const { plexus, root } = initTestPlexus(new Root({ containers: [], items: [] }));

      const depRoot = plexus.addDependency(depVector);

      expect(depRoot).toBeDefined();
      expect(depRoot.items).toHaveLength(2);
      expect(depRoot.items[0].name).toBe("item-a");
      expect(depRoot.items[1].name).toBe("item-b");
    });

    it("should make dependency models read-only", () => {
      const depVector = createDependencyDoc("pkg-2", ({ root }) => {
        root.items.push(new Item({ name: "original" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      // Dependency models should be read-only
      const item = depRoot.items[0];
      expect(item.name).toBe("original");

      // Writing to dependency models should throw
      expect(() => {
        (item as any).name = "modified";
      }).toThrow("dependencies are handled via special flow");

      expect(item.name).toBe("original"); // Value unchanged
    });

    it("should mark dependency models with isDependency flag", () => {
      const depVector = createDependencyDoc("pkg-3", ({ root }) => {
        root.items.push(new Item({ name: "test" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      expect(depRoot.__internals__.isDependency).toBe(true);
      expect(depRoot.items[0].__internals__.isDependency).toBe(true);
    });

    it("should prevent adding duplicate dependencies", () => {
      const depVector = createDependencyDoc("pkg-dup", ({ root }) => {
        root.items.push(new Item({ name: "test" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depVector);

      expect(() => plexus.addDependency(depVector)).toThrow("already exists");
    });
  });

  describe("Nested dependencies", () => {
    it("should resolve parent-child relationships within dependency", () => {
      const depVector = createDependencyDoc("pkg-nested", ({ root }) => {
        const container = new Container({ name: "parent", item: null, items: [] });
        const item = new Item({ name: "child" });
        container.item = item;
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      expect(depRoot.containers).toHaveLength(1);
      const container = depRoot.containers[0];
      expect(container.name).toBe("parent");
      expect(container.item).not.toBeNull();
      expect(container.item!.name).toBe("child");
    });

    it("should resolve child lists within dependency", () => {
      const depVector = createDependencyDoc("pkg-list", ({ root }) => {
        const container = new Container({ name: "holder", item: null, items: [] });
        container.items.push(new Item({ name: "first" }));
        container.items.push(new Item({ name: "second" }));
        container.items.push(new Item({ name: "third" }));
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      const container = depRoot.containers[0];
      expect(container.items).toHaveLength(3);
      expect(container.items[0].name).toBe("first");
      expect(container.items[1].name).toBe("second");
      expect(container.items[2].name).toBe("third");
    });

    it("should track parent references within dependency", () => {
      const depVector = createDependencyDoc("pkg-parent", ({ root }) => {
        const container = new Container({ name: "parent", item: null, items: [] });
        container.item = new Item({ name: "child" });
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      const container = depRoot.containers[0];
      const item = container.item!;

      // Parent tracking should work within dependency
      expect(item.parent).toBe(container);
      expect(container.parent).toBe(depRoot);
    });

    it("should handle deeply nested structures", () => {
      const depVector = createDependencyDoc("pkg-deep", ({ root }) => {
        const outer = new Container({ name: "outer", item: null, items: [] });
        // Note: Container can't nest Containers in this schema, so we test with items
        outer.items.push(new Item({ name: "deep-1" }));
        outer.items.push(new Item({ name: "deep-2" }));
        outer.item = new Item({ name: "single-child" });
        root.containers.push(outer);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      const outer = depRoot.containers[0];
      expect(outer.name).toBe("outer");
      expect(outer.item!.name).toBe("single-child");
      expect(outer.items[0].name).toBe("deep-1");
      expect(outer.items[1].name).toBe("deep-2");
    });
  });

  describe("rootDependenciesRepresentation", () => {
    it("should expose dependencies via proxy", () => {
      const depVector1 = createDependencyDoc("dep-a", ({ root }) => {
        root.items.push(new Item({ name: "from-a" }));
      });
      const depVector2 = createDependencyDoc("dep-b", ({ root }) => {
        root.items.push(new Item({ name: "from-b" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depVector1);
      plexus.addDependency(depVector2);

      const deps = plexus.rootDependenciesRepresentation;

      expect(deps["dep-a"]).toBeDefined();
      expect(deps["dep-b"]).toBeDefined();
      expect(deps["dep-a"].items[0].name).toBe("from-a");
      expect(deps["dep-b"].items[0].name).toBe("from-b");
    });

    it("should list dependency keys via ownKeys", () => {
      const depVector1 = createDependencyDoc("pkg-x", ({ root }) => {
        root.items.push(new Item({ name: "x" }));
      });
      const depVector2 = createDependencyDoc("pkg-y", ({ root }) => {
        root.items.push(new Item({ name: "y" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depVector1);
      plexus.addDependency(depVector2);

      const keys = Reflect.ownKeys(plexus.rootDependenciesRepresentation);
      expect(keys).toContain("pkg-x");
      expect(keys).toContain("pkg-y");
    });
  });

  describe("getDependencyNode", () => {
    it("should retrieve specific nodes by id", () => {
      const depVector = createDependencyDoc("pkg-get", ({ root }) => {
        root.items.push(new Item({ name: "findme" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depVector);

      // Get the item's uuid from the dependency
      const item = depRoot.items[0];
      const itemUuid = item.__internals__.uuid!;

      // Should be able to retrieve via getDependencyNode
      const retrieved = plexus.__getDependencyNode__("pkg-get", itemUuid);
      expect(retrieved).toBe(item); // Same cached instance
    });

    it("should throw for unknown dependency", () => {
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      expect(() => plexus.__getDependencyNode__("unknown-pkg", "some-uuid")).toThrow("cannot resolve dependency");
    });
  });
});
