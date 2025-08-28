import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { docDependencyResolverMap, load } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";

type DepBadList = ModelType<
  {
    readonly items: string[];
  },
  "DepBadList"
>;

type Root = ModelType<
  {
    name: string;
  },
  "Root"
>;

const Root = buildModelClass<Root>("Root", { name: "val" });

describe("Dependencies – Corruption & Shape Validation", () => {
  let rootDoc: Y.Doc;
  let depDoc: Y.Doc;

  beforeEach(() => {
    rootDoc = new Y.Doc();
    depDoc = new Y.Doc();
    primeDoc(rootDoc);
    primeDoc(depDoc);

    const root = new Root({ name: "root" });
    (root as any)[referenceSymbol](rootDoc);
    storeAsRoot(rootDoc, root as any);
  });

  it("throws for unknown constructor type in dependency", () => {
    const id = "x1";
    const models = depDoc.getMap<Y.Map<any>>("models");
    const types = depDoc.getMap<string>("models:types");
    models.set(id, new Y.Map());
    types.set(id, "TotallyUnknownType");

    load<Root>(rootDoc, { dep: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    expect(() => resolve(id, "dep")).toThrow(/cannot find model type/i);
  });

  it("throws for missing model data in dependency", () => {
    const id = "x2";
    const types = depDoc.getMap<string>("models:types");
    types.set(id, "DepBadList");

    load<Root>(rootDoc, { dep: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    expect(() => resolve(id, "dep")).toThrow(/cannot find model data/i);
  });

  it("throws for invalid field shape in dependency snapshot (list stored as number)", () => {
    const id = "x3";
    const models = depDoc.getMap<Y.Map<any>>("models");
    const types = depDoc.getMap<string>("models:types");
    const m = new Y.Map<any>();
    m.set("items", 42); // invalid shape
    models.set(id, m);
    types.set(id, "DepBadList");

    load<Root>(rootDoc, { dep: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    expect(() => resolve(id, "dep")).toThrow();
  });

  it("throws when sub-dependency alias is missing from mapping", () => {
    // Build a dep entity that references a sub-dep via alias 'shared'
    const sharedDoc = new Y.Doc();
    primeDoc(sharedDoc);
    const sharedId = "s1";
    const sharedFields = new Y.Map<any>();
    sharedFields.set("title", "ok");
    sharedDoc.getMap<Y.Map<any>>("models").set(sharedId, sharedFields);
    sharedDoc.getMap<string>("models:types").set(sharedId, "Shared");

    const depEntityId = "d1";
    const dFields = new Y.Map<any>();
    dFields.set("items", Y.Array.from([[sharedId, "shared"]])); // invalid alias for this load
    depDoc.getMap<Y.Map<any>>("models").set(depEntityId, dFields);
    depDoc.getMap<string>("models:types").set(depEntityId, "DepBadList");

    load<Root>(rootDoc, { dep: depDoc }); // note: 'shared' alias not provided
    const resolve = docDependencyResolverMap.get(rootDoc)!;

    // On resolve, trying to traverse items should fail when it touches the tuple
    expect(() => resolve(depEntityId, "dep")).toThrow();
  });

  it("does not crash when dependency doc is destroyed before deref", () => {
    const id = "x4";
    const models = depDoc.getMap<Y.Map<any>>("models");
    const types = depDoc.getMap<string>("models:types");
    const m = new Y.Map<any>();
    m.set("items", Y.Array.from([]));
    models.set(id, m);
    types.set(id, "DepBadList");

    load<Root>(rootDoc, { dep: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    depDoc.destroy();
    // Behavior may vary by YJS internals; the important part is not crashing
    expect(() => resolve(id, "dep")).not.toThrow();
  });
});
