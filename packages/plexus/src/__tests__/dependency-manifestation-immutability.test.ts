import { describe, expect, it } from "vitest";
import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { initTestPlexus } from "./test-plexus.js";
import type { DependencyId, DependencyVersion } from "../plexus.js";

type DepEntity = ModelType<
  {
    name: string;
    readonly items: string[];
    readonly tags: Set<string>;
    readonly map: Record<string, string>;
  },
  "DepEntity"
>;

type RootEntity = ModelType<
  {
    name: string;
    readonly dependencies: Set<DepEntity>;
    readonly dependencyVersion: Record<DependencyId, DependencyVersion>;
  },
  "RootEntity"
>;

const DepEntity = buildModelClass<DepEntity>("DepEntity", {
  name: "val",
  items: "list",
  tags: "set",
  map: "record"
});

const RootEntity = buildModelClass<RootEntity>("RootEntity", {
  name: "val",
  dependencies: "set",
  dependencyVersion: "record"
});

describe("Dependency manifestations are read-only", () => {
  it("prevents mutating list/set/record on dependency root", async () => {
    // Prepare dependency doc
    const depRootEntity = new DepEntity({
      name: "Alpha",
      items: ["a"],
      tags: new Set(["t1"]),
      map: { k: "v" }
    });
    const { doc: depDoc } = await initTestPlexus<DepEntity>(depRootEntity);

    // Root doc with dependency support
    const mainRoot = new RootEntity({
      name: "Root",
      dependencies: new Set(),
      dependencyVersion: {}
    });
    const { plexus, root } = await initTestPlexus<RootEntity>(mainRoot);

    // Register dependency and add
    plexus.registerDependencyFactory("depA", async () => depDoc);
    const dep = await plexus.addDependency<DepEntity>("depA" as DependencyId, "1.0.0" as DependencyVersion);

    // Ensure manifestation is part of dependencies
    expect(root.dependencies.has(dep)).toBe(true);

    // Record operations should throw (restricted record + frozen)
    expect(() => (dep.map as any).assign({ x: "y" })).toThrow();
    expect(() => (dep.map as any).clear()).toThrow();
    expect(() => ((dep.map as any).x = "y")).toThrow();

    // Set operations should throw (RestrictedSet)
    expect(() => (dep.tags as any).add("t2")).toThrow();
    expect(() => (dep.tags as any).delete("t1")).toThrow();
    expect(() => (dep.tags as any).clear()).toThrow();
    expect(() => (dep.tags as any).assign(["t3"]).toString()).toThrow();

    // Array/list operations should throw (RestrictedArray + frozen)
    expect(() => (dep.items as any).assign(["x"])).toThrow();
    expect(() => (dep.items as any).clear()).toThrow();
    expect(() => (dep.items as any).push("x")).toThrow();
    expect(() => (dep.items as any).splice(0, 1)).toThrow();
    expect(() => (dep.items as any).pop()).toThrow();
  });
});

