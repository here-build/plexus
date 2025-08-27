import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { docDependencyResolverMap, load } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";
import { deref } from "../deref.js";

// Dependency entity (no collections to avoid resolver shape issues)
type DepEntity = ModelType<
  {
    name: string;
    version: number;
  },
  "DepEntity"
>;

// Root entity holds references to dependency entities
type RootEntity = ModelType<
  {
    name: string;
    ref: DepEntity | null;
    readonly depsRecord: Record<string, DepEntity>;
    readonly depsList: DepEntity[];
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
  depsList: "list"
});

describe("Dependencies Interactions", () => {
  let depA: Y.Doc;
  let depB: Y.Doc;
  let rootDoc: Y.Doc;

  let depAEntityId: string;
  let depBEntityId: string;

  beforeEach(() => {
    depA = new Y.Doc();
    depB = new Y.Doc();
    rootDoc = new Y.Doc();
    primeDoc(depA);
    primeDoc(depB);
    primeDoc(rootDoc);

    // Materialize dependency entities
    const a = new DepEntity({ name: "Alpha", version: 1 });
    const b = new DepEntity({ name: "Beta", version: 2 });
    const [aId] = (a as any)[referenceSymbol](depA);
    const [bId] = (b as any)[referenceSymbol](depB);
    depAEntityId = aId;
    depBEntityId = bId;

    // Prepare root
    const root = new RootEntity({ name: "Root", ref: null, depsRecord: {}, depsList: [] });
    (root as any)[referenceSymbol](rootDoc);
    storeAsRoot(rootDoc, root as any);
  });

  it("stores tuple refs when writing dependency entities to root", () => {
    // Load root with deps
    const root = load<RootEntity>(rootDoc, { depA, depB });

    // Resolve dep manifestations for root context
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const depAObj = resolve(depAEntityId, "depA") as DepEntity;
    const depBObj = resolve(depBEntityId, "depB") as DepEntity;

    // Write into root collections
    root.ref = depAObj;
    root.depsRecord["a"] = depAObj;
    root.depsList.push(depBObj);

    // Inspect Y storage in root
    const models = rootDoc.getMap<Y.Map<any>>("models");
    const rootFields = models.get((root as any).uuid)!;

    expect(rootFields.get("ref")).toEqual([depAEntityId, "depA"]);
    expect(rootFields.get("depsRecord").get("a")).toEqual([depAEntityId, "depA"]);
    expect(rootFields.get("depsList").get(0)).toEqual([depBEntityId, "depB"]);
  });

  it("resolves dependency refs as read-only manifestations", () => {
    const root = load<RootEntity>(rootDoc, { depA });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const depAObj = resolve(depAEntityId, "depA") as DepEntity;

    root.ref = depAObj;

    const got = root.ref!;
    expect(got.name).toBe("Alpha");

    // Attempting to mutate dependency manifestation should fail (read-only)
    expect(() => {
      got.name = "Changed";
    }).toThrow();
  });

  it("supports multiple dependencies in the same root", () => {
    const root = load<RootEntity>(rootDoc, { depA, depB });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const a = resolve(depAEntityId, "depA") as DepEntity;
    const b = resolve(depBEntityId, "depB") as DepEntity;

    root.depsList.push(a, b);

    const models = rootDoc.getMap<Y.Map<any>>("models");
    const rootFields = models.get((root as any).uuid)!;
    const arr = rootFields.get("depsList") as Y.Array<any>;

    expect(arr.get(0)).toEqual([depAEntityId, "depA"]);
    expect(arr.get(1)).toEqual([depBEntityId, "depB"]);
  });

  it("throws when dependency mapping is missing for a stored tuple ref", () => {
    // Initialize resolver with only depA
    load<RootEntity>(rootDoc, { depA });
    // Attempt to deref a tuple referencing an unknown package id
    expect(() => deref(rootDoc, [depBEntityId, "unknownPkg"] as any)).toThrow();
  });
});
