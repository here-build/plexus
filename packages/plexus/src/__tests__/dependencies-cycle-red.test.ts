import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { load, docDependencyResolverMap } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

// Minimal peer types with mutual references via val field
type AType = ModelType<
  {
    name: string;
    peer: BType | null;
  },
  "A"
>;

type BType = ModelType<
  {
    label: string;
    peer: AType | null;
  },
  "B"
>;

const A = buildModelClass<AType>("A", { name: "val", peer: "val" });
const B = buildModelClass<BType>("B", { label: "val", peer: "val" });

describe("Dependencies – Cycle Support Across Packages", () => {
  let docA: Y.Doc;
  let docB: Y.Doc;
  let rootDoc: Y.Doc;
  let aId: string;
  let bId: string;

  beforeEach(() => {
    docA = new Y.Doc();
    docB = new Y.Doc();
    rootDoc = new Y.Doc();
    primeDoc(docA);
    primeDoc(docB);
    primeDoc(rootDoc);

    // Build A and B that point to each other via tuple refs
    const aFields = new Y.Map<any>();
    const bFields = new Y.Map<any>();
    aId = "Aid";
    bId = "Bid";
    aFields.set("name", "a");
    // temporarily set peer, to be filled after we set b
    bFields.set("label", "b");
    aFields.set(YJS_GLOBALS.modelMetadataType, "A");
    bFields.set(YJS_GLOBALS.modelMetadataType, "B");
    docA.getMap<Y.Map<any>>("models").set(aId, aFields);
    docB.getMap<Y.Map<any>>("models").set(bId, bFields);

    // Cross references
    aFields.set("peer", [bId, "b"]);
    bFields.set("peer", [aId, "a"]);

    // Root
    const root = new A({ name: "root-a", peer: null });
    (root as any).name; // touch
    // store as root to be able to call load consistently
    (root as any)[Symbol.for("reference")]?.(rootDoc);
    storeAsRoot(rootDoc, root as any);
  });

  it("resolves 2-node cycle without overflow and preserves identity", () => {
    load<any>(rootDoc, { a: docA, b: docB });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const a = resolve(aId, "a");
    const b = a.peer!;
    const a2 = b.peer!;
    expect(a2).toBe(a);
    expect(a.uuid).toBe(a2.uuid);
    expect(b.uuid).toBeDefined();
  });

  it("repeated derefs return the same objects for each (alias,id)", () => {
    load<any>(rootDoc, { a: docA, b: docB });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const a1 = resolve(aId, "a");
    const a2 = resolve(aId, "a");
    const b1 = resolve(bId, "b");
    const b2 = resolve(bId, "b");
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
  });

  it("supports self-reference without overflow", () => {
    // Build a doc C with self-referential peer
    const docC = new Y.Doc();
    primeDoc(docC);
    type CType = ModelType<{ name: string; peer: any | null }, "C">;
    const C = buildModelClass<CType>("C", { name: "val", peer: "val" });
    const cid = "Cid";
    const cFields = new Y.Map<any>();
    cFields.set("name", "c");
    docC.getMap<Y.Map<any>>("models").set(cid, cFields);
    cFields.set(YJS_GLOBALS.modelMetadataType, "C");
    // self reference
    cFields.set("peer", [cid, "c"]);
    load<any>(rootDoc, { c: docC });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const c = resolve(cid, "c");
    expect(c.peer).toBe(c);
  });

  it("handles mixed-shape cycles (val and list) across deps", () => {
    // Define C: { next: D|null } and D: { list: C[] }
    type C2 = ModelType<{ name: string; next: any | null }, "C2">;
    type D2 = ModelType<{ label: string; list: any[] }, "D2">;
    const C2 = buildModelClass<C2>("C2", { name: "val", next: "val" });
    const D2 = buildModelClass<D2>("D2", { label: "val", list: "list" });

    const docC2 = new Y.Doc();
    const docD2 = new Y.Doc();
    primeDoc(docC2);
    primeDoc(docD2);
    const c2Id = "c2";
    const d2Id = "d2";
    const c2Fields = new Y.Map<any>();
    const d2Fields = new Y.Map<any>();
    c2Fields.set("name", "c2");
    d2Fields.set("label", "d2");
    // store shells
    docC2.getMap<Y.Map<any>>("models").set(c2Id, c2Fields);
    c2Fields.set(YJS_GLOBALS.modelMetadataType, "C2");
    docD2.getMap<Y.Map<any>>("models").set(d2Id, d2Fields);
    d2Fields.set(YJS_GLOBALS.modelMetadataType, "D2");
    // link
    c2Fields.set("next", [d2Id, "d2pkg"]);
    d2Fields.set("list", Y.Array.from([[c2Id, "c2pkg"]]));

    load<any>(rootDoc, { c2pkg: docC2, d2pkg: docD2 });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const c2 = resolve(c2Id, "c2pkg");
    const d2 = c2.next!;
    expect(d2.list[0]).toBe(c2);
  });
});
