import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { initTestPlexus } from "./test-plexus.js";
import { Plexus } from "../plexus.js";

type Item = ModelType<
  {
    name: string;
  },
  "Item"
>;

type Container = ModelType<
  {
    title: string;
    readonly children: Item[];
    readonly tags: Set<string>;
    readonly meta: Record<string, string>;
  },
  "Container"
>;

type Root = ModelType<
  {
    name: string;
    readonly containers: Record<string, Container>;
    readonly dependencies: Set<Container>;
    readonly dependencyVersion: Record<string, string>;
  },
  "Root"
>;

const Item = buildModelClass<Item>("Item", { name: "val" });
const Container = buildModelClass<Container>("Container", {
  title: "val",
  children: "child-list",
  tags: "set",
  meta: "record"
});
const Root = buildModelClass<Root>("Root", {
  name: "val",
  containers: "record",
  dependencies: "set",
  dependencyVersion: "record"
});

describe("Clone from dependency node", () => {
  let depDoc: Y.Doc;
  let rootDoc: Y.Doc;
  let depContainerId: string;

  beforeEach(async () => {
    // Create dependency document with Plexus
    const depItem = new Item({ name: "child-dep" });
    const depContainer = new Container({
      title: "dep-container",
      children: [depItem],
      tags: new Set(["dep-tag"]),
      meta: { source: "dep" }
    });

    const { doc: createdDepDoc, root: materializedDepContainer } = await initTestPlexus<Container>(depContainer);
    depDoc = createdDepDoc;
    depContainerId = materializedDepContainer.uuid;

    // Create root document with Plexus
    const ephemeralRoot = new Root({
      name: "root",
      containers: {},
      dependencies: new Set(),
      dependencyVersion: {}
    });
    const { doc: createdRootDoc, plexus } = await initTestPlexus<Root>(ephemeralRoot);
    rootDoc = createdRootDoc;

    // Set up dependency factory for the root Plexus
    plexus.registerDependencyFactory("dep", async () => depDoc);
  });

  it("produces an editable clone and materializes it into root", async () => {
    const plexus = Plexus.docPlexus.get(rootDoc)!;
    const root = await plexus.rootPromise;

    // Add the dependency and access the entity
    const depRoot = await plexus.addDependency<Container>("dep", "latest");
    const depC = Container.spawn(depContainerId, await plexus.fetchDependency("dep", "latest"));

    const cloned = depC.clone();

    // Basic assertions
    expect(cloned).not.toBe(depC);
    expect(cloned.uuid).not.toBe(depC.uuid);
    expect(cloned.title).toBe("dep-container");
    expect(cloned.children.length).toBe(1);
    expect(cloned.children[0].name).toBe("child-dep");
    // Editable clone
    cloned.title = "local-clone";
    cloned.children[0].name = "child-local";
    cloned.tags.add("local");
    cloned.meta["from"] = "root";
    expect(cloned.title).toBe("local-clone");
    expect(cloned.children[0].name).toBe("child-local");
    expect(cloned.tags.has("local")).toBe(true);
    expect(cloned.meta["from"]).toBe("root");

    // Materialize by inserting into root record
    root.containers["c1"] = cloned;

    // Verify local tuples in storage (no package id)
    const models = rootDoc.getMap<Y.Map<any>>("models");
    const cId = (root.containers["c1"] as any).uuid as string;
    const cFields = models.get(cId)!;
    const children = cFields.get("children") as Y.Array<any>;
    expect(Array.isArray(children.get(0))).toBe(true);
    expect(children.get(0)).toHaveLength(1);
  });

  it("does not mutate dependency when editing the clone", async () => {
    const plexus = Plexus.docPlexus.get(rootDoc)!;

    // Add the dependency and access the entity
    await plexus.addDependency<Container>("dep", "latest");
    const depC = Container.spawn(depContainerId, await plexus.fetchDependency("dep", "latest"));

    const cloned = depC.clone();
    cloned.title = "mutated-clone";
    cloned.children[0].name = "mutated-child";

    // Dependency manifestation remains unchanged
    expect(depC.title).toBe("dep-container");
    expect(depC.children[0].name).toBe("child-dep");
  });
});
