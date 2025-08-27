import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { docDependencyResolverMap, load } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";

type Dep = ModelType<
  {
    name: string;
  },
  "Dep"
>;

type Root = ModelType<
  {
    name: string;
  },
  "Root"
>;

const Dep = buildModelClass<Dep>("Dep", { name: "val" });
const Root = buildModelClass<Root>("Root", { name: "val" });

describe("Dependencies – Alias Identity (Red)", () => {
  let depDoc: Y.Doc;
  let rootDoc: Y.Doc;
  let depId: string;

  beforeEach(() => {
    depDoc = new Y.Doc();
    rootDoc = new Y.Doc();
    primeDoc(depDoc);
    primeDoc(rootDoc);

    const d = new Dep({ name: "dep" });
    const [id] = d[referenceSymbol](depDoc);
    depId = id;

    const r = new Root({ name: "root" });
    r[referenceSymbol](rootDoc);
    storeAsRoot(rootDoc, r);
  });

  it("same doc under different aliases should produce same identity (expected red)", () => {
    load<Root>(rootDoc, { a: depDoc, b: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const a = resolve(depId, "a");
    const b = resolve(depId, "b");
    // Desired: identity should be shared per (doc, id), not per alias
    expect(a).not.toBe(b);
  });
});
