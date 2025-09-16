import { beforeEach, describe, expect, it } from "vitest";
import { PlexusModel } from "../PlexusModel.js";
import { syncing } from "../decorators.js";
import { initTestPlexus } from "./test-plexus.js";

@syncing
class Dep extends PlexusModel {
  @syncing.list
  accessor items!: string[];
}

@syncing
class Root extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.set
  accessor dependencies!: Set<Dep>;

  @syncing.map
  accessor dependencyVersion!: Record<string, string>;
}

describe("Dependencies – Array Bypass (Red)", () => {
  let depEntity: Dep;
  let rootPlexus: any;
  let root: Root;

  beforeEach(async () => {
    // Create dependency with items
    depEntity = new Dep({ items: ["a"] });
    const { doc: depDoc } = await initTestPlexus(depEntity);

    // Create root with dependency support
    const rootEntity = new Root({ name: "root" });
    const { plexus } = await initTestPlexus(rootEntity);
    rootPlexus = plexus;
    root = await plexus.rootPromise;

    // Register dependency factory
    rootPlexus.registerDependencyFactory("dep", async () => depDoc);
  });

  it("Array.prototype.push.call should not mutate dependency list (expected red)", async () => {
    // Add dependency and get manifestation
    const depRoot = await rootPlexus.addDependency<Dep>("dep", "latest");

    // Bypass any overridden methods on the array instance
    expect(() => {
      Array.prototype.push.call((depRoot as any).items, "bypass");
    }).toThrow();

    // Desired: still immutable; current behavior: mutation succeeds
    expect((depRoot as any).items.includes("bypass")).toBe(false);
  });
});
