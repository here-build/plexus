import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { docDependencyResolverMap, load } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

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
    models.set(id, new Y.Map([[YJS_GLOBALS.modelMetadataType, "TotallyUnknownType"]] as const));

    load<Root>(rootDoc, { dep: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    expect(() => resolve(id, "dep")).toThrow(/cannot find model type/i);
  });

  it("throws for invalid field shape in dependency snapshot (list stored as number)", () => {
    const id = "x3";
    const models = depDoc.getMap<Y.Map<any>>("models");
    const m = new Y.Map<any>();
    m.set("items", 42); // invalid shape
    models.set(id, m);
    m.set(YJS_GLOBALS.modelMetadataType, "DepBadList");

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
    const model = sharedDoc.getMap<Y.Map<any>>("models").set(sharedId, sharedFields);
    sharedFields.set(YJS_GLOBALS.modelMetadataType, "Shared");

    const depEntityId = "d1";
    const dFields = new Y.Map<any>();
    dFields.set("items", Y.Array.from([[sharedId, "shared"]])); // invalid alias for this load
    depDoc.getMap<Y.Map<any>>("models").set(depEntityId, dFields);
    dFields.set(YJS_GLOBALS.modelMetadataType, "DepBadList");

    load<Root>(rootDoc, { dep: depDoc }); // note: 'shared' alias not provided
    const resolve = docDependencyResolverMap.get(rootDoc)!;

    // On resolve, trying to traverse items should fail when it touches the tuple
    expect(() => resolve(depEntityId, "dep")).toThrow();
  });
});
