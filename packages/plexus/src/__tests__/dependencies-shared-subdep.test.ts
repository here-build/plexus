import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { load, docDependencyResolverMap } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";

// Shared sub-dependency model
type SharedType = ModelType<
  {
    title: string;
  },
  "Shared"
>;

// Dependency A and B each reference shared
type DepAType = ModelType<
  {
    name: string;
    shared: SharedType | null;
  },
  "DepA"
>;

type DepBType = ModelType<
  {
    label: string;
    shared: SharedType | null;
  },
  "DepB"
>;

// Minimal root model
type RootType = ModelType<
  {
    name: string;
  },
  "Root"
>;

const Shared = buildModelClass<SharedType>("Shared", { title: "val" });
const DepA = buildModelClass<DepAType>("DepA", { name: "val", shared: "val" });
const DepB = buildModelClass<DepBType>("DepB", { label: "val", shared: "val" });
const Root = buildModelClass<RootType>("Root", { name: "val" });

describe("Dependencies – Shared Sub-dependency", () => {
  let sharedDoc: Y.Doc;
  let depADoc: Y.Doc;
  let depBDoc: Y.Doc;
  let rootDoc: Y.Doc;

  let sharedId: string;
  let depAId: string;
  let depBId: string;

  beforeEach(() => {
    sharedDoc = new Y.Doc();
    depADoc = new Y.Doc();
    depBDoc = new Y.Doc();
    rootDoc = new Y.Doc();
    primeDoc(sharedDoc);
    primeDoc(depADoc);
    primeDoc(depBDoc);
    primeDoc(rootDoc);

    // Materialize Shared in its own doc
    const shared = new Shared({ title: "Common" });
    const [sid] = (shared as any)[referenceSymbol](sharedDoc);
    sharedId = sid;

    // Store DepA model referencing [sharedId, 'shared']
    const aFields = new Y.Map<any>();
    aFields.set("name", "A");
    aFields.set("shared", [sharedId, "shared"]);
    depAId = "depA-1";
    depADoc.getMap<Y.Map<any>>("models").set(depAId, aFields);
    depADoc.getMap<string>("models:types").set(depAId, "DepA");

    // Store DepB model referencing [sharedId, 'shared']
    const bFields = new Y.Map<any>();
    bFields.set("label", "B");
    bFields.set("shared", [sharedId, "shared"]);
    depBId = "depB-1";
    depBDoc.getMap<Y.Map<any>>("models").set(depBId, bFields);
    depBDoc.getMap<string>("models:types").set(depBId, "DepB");

    // Prepare root
    const root = new Root({ name: "root" });
    (root as any)[referenceSymbol](rootDoc);
    storeAsRoot(rootDoc, root as any);
  });

  it("derefs sub-dependency from two parents consistently", () => {
    load<RootType>(rootDoc, { a: depADoc, b: depBDoc, shared: sharedDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;

    const a = resolve(depAId, "a");
    const b = resolve(depBId, "b");

    expect(a.shared).toBeTruthy();
    expect(b.shared).toBeTruthy();
    expect(a.shared!.title).toBe("Common");
    expect(b.shared!.title).toBe("Common");
    expect(a.shared!.uuid).toBe(b.shared!.uuid); // same entity id
  });

  it("allows mixing nested structures around a shared dep", () => {
    // Extend deps to include list/record references to shared as well
    // Here we only verify that loader can follow multiple occurrences consistently
    load<RootType>(rootDoc, { a: depADoc, b: depBDoc, shared: sharedDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;

    const a = resolve(depAId, "a");
    const b = resolve(depBId, "b");

    // Access twice to exercise caching/snapshot behavior
    const s1 = a.shared!;
    const s2 = b.shared!;
    expect(s1.uuid).toBe(sharedId);
    expect(s2.uuid).toBe(sharedId);
    // Same entity id indicates consistent deref across parents
  });
});

