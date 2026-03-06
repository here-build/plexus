/**
 * Tests for dependency system - loading external packages as read-only snapshots.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { getInternals, PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("Item")
class Item extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("Container")
class Container extends PlexusModel {
  @syncing accessor name: string = "";

  @syncing.child accessor item: Item | null = null;

  @syncing.child.list accessor items: Item[] = [];
}

@syncing("Root")
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

  return [documentId, Y.encodeStateAsUpdate(doc)] as const;
}

describe("Dependency system", () => {
  describe("Basic dependency loading", () => {
    it("should load a simple dependency with flat items", () => {
      const [depId, depVector] = createDependencyDoc("pkg-1", ({ root }) => {
        root.items.push(new Item({ name: "item-a" }));
        root.items.push(new Item({ name: "item-b" }));
      });

      const { plexus, root } = initTestPlexus(new Root({ containers: [], items: [] }));

      const depRoot = plexus.addDependency(depId, depVector);

      expect(depRoot).to.not.eq(undefined);
      expect(depRoot.items).to.have.lengthOf(2);
      expect([depRoot.items[0].name, depRoot.items[1].name]).to.have.ordered.members(["item-a", "item-b"]);
    });

    it("should make dependency models read-only", () => {
      const [depId, depVector] = createDependencyDoc("pkg-2", ({ root }) => {
        root.items.push(new Item({ name: "original" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      // Dependency models should be read-only
      const item = depRoot.items[0];
      expect(item.name).to.equal("original");

      // Writing to dependency models should throw
      expect(() => {
        (item as any).name = "modified";
      }).to.throw("dependencies are handled via special flow");

      expect(item.name).to.equal("original"); // Value unchanged
    });

    it("should mark dependency models with isDependency flag", () => {
      const [depId, depVector] = createDependencyDoc("pkg-3", ({ root }) => {
        root.items.push(new Item({ name: "test" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      expect([getInternals(depRoot).isDependency, getInternals(depRoot.items[0]).isDependency]).to.have.ordered.members(
        [true, true],
      );
    });

    it("should prevent adding duplicate dependencies", () => {
      const [depId, depVector] = createDependencyDoc("pkg-dup", ({ root }) => {
        root.items.push(new Item({ name: "test" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depId, depVector);

      expect(() => plexus.addDependency(depId, depVector)).to.throw("already exists");
    });
  });

  describe("Nested dependencies", () => {
    it("should resolve parent-child relationships within dependency", () => {
      const [depId, depVector] = createDependencyDoc("pkg-nested", ({ root }) => {
        const container = new Container({ name: "parent", item: null, items: [] });
        const item = new Item({ name: "child" });
        container.item = item;
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      expect(depRoot.containers).to.have.lengthOf(1);
      const container = depRoot.containers[0];
      expect(container.name).to.equal("parent");
      expect(container.item).to.not.eq(null);
      expect(container.item!.name).to.equal("child");
    });

    it("should resolve child lists within dependency", () => {
      const [depId, depVector] = createDependencyDoc("pkg-list", ({ root }) => {
        const container = new Container({ name: "holder", item: null, items: [] });
        container.items.push(new Item({ name: "first" }));
        container.items.push(new Item({ name: "second" }));
        container.items.push(new Item({ name: "third" }));
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      const container = depRoot.containers[0];
      expect(container.items).to.have.lengthOf(3);
      expect([container.items[0].name, container.items[1].name, container.items[2].name]).to.have.ordered.members([
        "first",
        "second",
        "third",
      ]);
    });

    it("should track parent references within dependency", () => {
      const [depId, depVector] = createDependencyDoc("pkg-parent", ({ root }) => {
        const container = new Container({ name: "parent", item: null, items: [] });
        container.item = new Item({ name: "child" });
        root.containers.push(container);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      const container = depRoot.containers[0];
      const item = container.item!;

      // Parent tracking should work within dependency
      expect([item.parent === container, container.parent === depRoot]).to.have.ordered.members([true, true]);
    });

    it("should handle deeply nested structures", () => {
      const [depId, depVector] = createDependencyDoc("pkg-deep", ({ root }) => {
        const outer = new Container({ name: "outer", item: null, items: [] });
        // Note: Container can't nest Containers in this schema, so we test with items
        outer.items.push(new Item({ name: "deep-1" }));
        outer.items.push(new Item({ name: "deep-2" }));
        outer.item = new Item({ name: "single-child" });
        root.containers.push(outer);
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      const outer = depRoot.containers[0];
      expect([outer.name, outer.item!.name, outer.items[0].name, outer.items[1].name]).to.have.ordered.members([
        "outer",
        "single-child",
        "deep-1",
        "deep-2",
      ]);
    });
  });

  describe("rootDependenciesRepresentation", () => {
    it("should expose dependencies via proxy", () => {
      const [depId1, depVector1] = createDependencyDoc("dep-a", ({ root }) => {
        root.items.push(new Item({ name: "from-a" }));
      });
      const [depId2, depVector2] = createDependencyDoc("dep-b", ({ root }) => {
        root.items.push(new Item({ name: "from-b" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depId1, depVector1);
      plexus.addDependency(depId2, depVector2);

      const deps = plexus.rootDependenciesRepresentation;

      expect(deps["dep-a"]).to.not.eq(undefined);
      expect(deps["dep-b"]).to.not.eq(undefined);
      expect([deps["dep-a"].items[0].name, deps["dep-b"].items[0].name]).to.have.ordered.members(["from-a", "from-b"]);
    });

    it("should list dependency keys via ownKeys", () => {
      const [depId1, depVector1] = createDependencyDoc("pkg-x", ({ root }) => {
        root.items.push(new Item({ name: "x" }));
      });
      const [depId2, depVector2] = createDependencyDoc("pkg-y", ({ root }) => {
        root.items.push(new Item({ name: "y" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      plexus.addDependency(depId1, depVector1);
      plexus.addDependency(depId2, depVector2);

      const keys = Reflect.ownKeys(plexus.rootDependenciesRepresentation);
      expect(keys).to.include("pkg-x").and.include("pkg-y");
    });
  });

  describe("getDependencyNode", () => {
    it("should retrieve specific nodes by id", () => {
      const [depId, depVector] = createDependencyDoc("pkg-get", ({ root }) => {
        root.items.push(new Item({ name: "findme" }));
      });

      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));
      const depRoot = plexus.addDependency(depId, depVector);

      // Get the item's uuid from the dependency
      const item = depRoot.items[0];
      const itemUuid = getInternals(item).uuid!;

      // Should be able to retrieve via getDependencyNode
      const retrieved = plexus.__getDependencyNode__("pkg-get", itemUuid);
      expect(retrieved === item).to.eq(true); // Same cached instance
    });

    it("should throw for unknown dependency", () => {
      const { plexus } = initTestPlexus(new Root({ containers: [], items: [] }));

      expect(() => plexus.__getDependencyNode__("unknown-pkg", "some-uuid")).to.throw("cannot resolve dependency");
    });
  });
});
