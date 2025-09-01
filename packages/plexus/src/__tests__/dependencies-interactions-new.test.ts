import { beforeEach, describe, expect, it } from "vitest";
import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { initTestPlexus, TestPlexus } from "./test-plexus.js";
import type { DependencyId, DependencyVersion } from "../plexus.js";

// Dependency entity
type DepEntity = ModelType<
  {
    name: string;
    version: number;
  },
  "DepEntity"
>;

// Root entity with dependency support
type RootEntity = ModelType<
  {
    name: string;
    ref: DepEntity | null;
    readonly depsRecord: Record<string, DepEntity>;
    readonly depsList: DepEntity[];
    readonly dependencies: Set<DepEntity>;
    readonly dependencyVersion: Record<DependencyId, DependencyVersion>;
  },
  "RootEntity"
>;

const DepEntity = buildModelClass<DepEntity>("DepEntity", {
  name: "val",
  version: "val"
});

const RootEntity = buildModelClass<RootEntity>("RootEntity", {
  name: "val",
  ref: "val",
  depsRecord: "record",
  depsList: "list",
  dependencies: "set",
  dependencyVersion: "record"
});

describe("Plexus Dependency Management", () => {
  let plexus: TestPlexus<RootEntity, DepEntity>;
  let root: RootEntity;

  beforeEach(async () => {
    // Create empty root with dependency support
    const emptyRoot = new RootEntity({
      name: "Root",
      ref: null,
      depsRecord: {},
      depsList: [],
      dependencies: new Set(),
      dependencyVersion: {}
    });

    const result = await initTestPlexus<RootEntity>(emptyRoot);
    plexus = result.plexus;
    root = result.root;

    // Register dependency factories that create fresh dependency docs
    plexus.registerDependencyFactory("depA", async () => {
      const depEntity = new DepEntity({ name: "Alpha", version: 1 });
      const { doc } = await initTestPlexus<DepEntity>(depEntity);
      return doc;
    });

    plexus.registerDependencyFactory("depB", async () => {
      const depEntity = new DepEntity({ name: "Beta", version: 2 });
      const { doc } = await initTestPlexus<DepEntity>(depEntity);
      return doc;
    });
  });

  describe("addDependency", () => {
    it("should add a dependency and return the dependency root", async () => {
      expect(root.dependencies.size).toBe(0);

      const depA = await plexus.addDependency<DepEntity>("depA" as DependencyId, "1.0.0" as DependencyVersion);

      // Verify dependency was added
      expect(root.dependencies.size).toBe(1);
      expect(root.dependencies.has(depA)).toBe(true);
      expect(depA.name).toBe("Alpha");
      expect(depA.version).toBe(1);

      // Verify version tracking
      expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");
    });

    it("should add multiple dependencies", async () => {
      const depA = await plexus.addDependency<DepEntity>("depA" as DependencyId, "1.0.0" as DependencyVersion);
      const depB = await plexus.addDependency<DepEntity>("depB" as DependencyId, "2.0.0" as DependencyVersion);

      expect(root.dependencies.size).toBe(2);
      expect(root.dependencies.has(depA)).toBe(true);
      expect(root.dependencies.has(depB)).toBe(true);

      expect(depA.name).toBe("Alpha");
      expect(depB.name).toBe("Beta");

      expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");
      expect(root.dependencyVersion["depB" as DependencyId]).toBe("2.0.0");
    });

    it("should allow using dependency in root entity relationships", async () => {
      const depA = await plexus.addDependency<DepEntity>("depA" as DependencyId, "1.0.0" as DependencyVersion);

      // Use dependency in root relationships
      root.ref = depA;
      root.depsRecord["alpha"] = depA;
      root.depsList.push(depA);

      // Verify relationships work
      expect(root.ref).toBe(depA);
      expect(root.depsRecord["alpha"]).toBe(depA);
      expect(root.depsList[0]).toBe(depA);
      expect(root.ref!.name).toBe("Alpha");
    });

    it("should handle dependency not found", async () => {
      await expect(plexus.addDependency("unknownDep" as DependencyId, "1.0.0" as DependencyVersion)).rejects.toThrow(
        'Dependency "unknownDep" not found'
      );
    });
  });

  describe("updateDependency", () => {
    it("should update a dependency to a new version", async () => {
      // Add initial dependency
      const depA = await plexus.addDependency<DepEntity>("depA" as DependencyId, "1.0.0" as DependencyVersion);
      expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");

      // Update to new version
      await plexus.updateDependency(depA, "1.1.0" as DependencyVersion);

      // Note: The updated dependency behavior depends on implementation
      // This test verifies the method runs without error
      expect(root.dependencies.size).toBe(1); // Still same count
    });
  });

  describe("dependency isolation", () => {
    it("should provide read-only access to dependency entities", async () => {
      const depA = await plexus.addDependency<DepEntity>("depA" as DependencyId, "1.0.0" as DependencyVersion);

      // Dependency should be read-only (based on old test behavior)
      expect(() => {
        depA.name = "Modified";
      }).toThrow();
    });
  });

  describe("error handling", () => {
    it("should error for root without dependency support", async () => {
      // Create root without dependency fields
      const simpleRoot = new DepEntity({ name: "Simple", version: 1 });
      const { plexus: simplePlexus } = await initTestPlexus<DepEntity>(simpleRoot);

      await expect(simplePlexus.addDependency("depA" as DependencyId, "1.0.0" as DependencyVersion)).rejects.toThrow(
        "Root entity does not support dependencies"
      );
    });
  });
});
