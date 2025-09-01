import { beforeEach, describe, expect, it } from "vitest";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { initTestPlexus } from "./test-plexus.js";

type Dep = ModelType<
  {
    readonly items: string[];
  },
  "DepArr"
>;

type Root = ModelType<
  {
    name: string;
    readonly dependencies: Set<Dep>;
    readonly dependencyVersion: Record<string, string>;
  },
  "Root"
>;

const Dep = buildModelClass<Dep>("DepArr", { items: "list" });
const Root = buildModelClass<Root>("Root", {
  name: "val",
  dependencies: "set",
  dependencyVersion: "record"
});

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
