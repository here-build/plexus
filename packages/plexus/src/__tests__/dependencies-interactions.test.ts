import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { initTestPlexus } from "./test-plexus.js";
import type { DependencyId, DependencyVersion } from "../plexus.js";

// Dependency entity (no collections to avoid resolver shape issues)
type DepEntity = ModelType<
  {
    name: string;
    version: number;
  },
  "DepEntity"
>;

// Root entity holds references to dependency entities and manages dependency versions
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

describe("Dependencies Interactions with Plexus", () => {
  let depA: Y.Doc;
  let depB: Y.Doc;
  let rootDoc: Y.Doc;
  let root: RootEntity;

  let depAEntityId: string;
  let depBEntityId: string;
  let depAEntity: DepEntity;
  let depBEntity: DepEntity;

  beforeEach(async () => {
    // Initialize dependency docs with their entities as roots
    const depAEntity_temp = new DepEntity({ name: "Alpha", version: 1 });
    const depBEntity_temp = new DepEntity({ name: "Beta", version: 2 });

    const { doc: depADoc, root: depARoot } = await initTestPlexus<DepEntity>(depAEntity_temp);
    const { doc: depBDoc, root: depBRoot } = await initTestPlexus<DepEntity>(depBEntity_temp);

    depA = depADoc;
    depB = depBDoc;
    depAEntity = depARoot;
    depBEntity = depBRoot;
    depAEntityId = depAEntity.uuid;
    depBEntityId = depBEntity.uuid;

    // Create root with basic structure (empty dependencies initially)
    const testRoot = new RootEntity({
      name: "Root",
      ref: null,
      depsRecord: {},
      depsList: [],
      dependencies: new Set(), // Start empty - will use addDependency()
      dependencyVersion: {} // Start empty - will be populated via addDependency()
    });

    // Initialize main doc with root and dependencies
    const { plexus, root: loadedRoot } = await initTestPlexus<RootEntity>(testRoot);
    rootDoc = plexus.doc;
    root = loadedRoot;

    // Register dependency factories for this test
    (plexus as any).registerDependencyFactory("depA", async () => depA);
    (plexus as any).registerDependencyFactory("depB", async () => depB);

    // Now explicitly add dependencies using the new API
    await plexus.addDependency("depA" as DependencyId, "1.0.0" as DependencyVersion);
    await plexus.addDependency("depB" as DependencyId, "2.0.0" as DependencyVersion);
  });

  it("should automatically resolve and track dependency entities", () => {
    // Verify dependencies are available through root
    expect(root.dependencies.size).toBe(2);
    const deps = Array.from(root.dependencies);
    expect(deps.some((dep) => dep.name === "Alpha")).toBe(true);
    expect(deps.some((dep) => dep.name === "Beta")).toBe(true);

    // Verify dependency versions are tracked
    expect(root.dependencyVersion["depA" as DependencyId]).toBe("1.0.0");
    expect(root.dependencyVersion["depB" as DependencyId]).toBe("2.0.0");
  });

  it("stores tuple refs when writing dependency entities to root", () => {
    // Get dependency references from Set
    const deps = Array.from(root.dependencies);
    const depAObj = deps.find((dep) => dep.name === "Alpha")!;
    const depBObj = deps.find((dep) => dep.name === "Beta")!;

    // Write into root collections
    root.ref = depAObj;
    root.depsRecord["a"] = depAObj;
    root.depsList.push(depBObj);

    // Inspect Y storage in root - dependency references should be stored as tuples
    const models = rootDoc.getMap<Y.Map<any>>("models");
    const rootFields = models.get((root as any).uuid)!;

    expect(rootFields.get("ref")).toEqual([depAEntityId, "depA"]);
    expect(rootFields.get("depsRecord").get("a")).toEqual([depAEntityId, "depA"]);
    expect(rootFields.get("depsList").get(0)).toEqual([depBEntityId, "depB"]);
  });

  it("resolves dependency refs as read-only manifestations", () => {
    // Get dependency from Set
    const deps = Array.from(root.dependencies);
    const depAObj = deps.find((dep) => dep.name === "Alpha")!;
    root.ref = depAObj;

    const got = root.ref!;
    expect(got.name).toBe("Alpha");

    // Attempting to mutate dependency manifestation should fail (read-only)
    expect(() => {
      got.name = "Changed";
    }).toThrow();
  });

  it("supports multiple dependencies in the same root", () => {
    // Get dependencies from Set
    const deps = Array.from(root.dependencies);
    const a = deps.find((dep) => dep.name === "Alpha")!;
    const b = deps.find((dep) => dep.name === "Beta")!;

    root.depsList.push(a, b);

    const models = rootDoc.getMap<Y.Map<any>>("models");
    const rootFields = models.get((root as any).uuid)!;
    const arr = rootFields.get("depsList") as Y.Array<any>;

    expect(arr.get(0)).toEqual([depAEntityId, "depA"]);
    expect(arr.get(1)).toEqual([depBEntityId, "depB"]);
  });

  it("throws when dependency is not provided to Plexus", async () => {
    // Create a fresh root with empty dependencies
    const failRoot = new RootEntity({
      name: "FailRoot",
      ref: null,
      depsRecord: {},
      depsList: [],
      dependencies: new Set(),
      dependencyVersion: {}
    });

    // Create fresh plexus without registering all dependencies
    const { plexus: freshPlexus } = await initTestPlexus<RootEntity>(failRoot);

    // Only register depA, not depB
    (freshPlexus as any).registerDependencyFactory("depA", async () => depA);
    // depB is intentionally missing

    // Should succeed for depA
    await expect(
      freshPlexus.addDependency("depA" as DependencyId, "1.0.0" as DependencyVersion)
    ).resolves.toBeDefined();

    // Should fail for missing depB
    await expect(freshPlexus.addDependency("depB" as DependencyId, "2.0.0" as DependencyVersion)).rejects.toThrow(
      'Dependency "depB" not found'
    );
  });
});
