import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { docDependencyResolverMap, load } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";

type Dep = ModelType<
  {
    readonly items: string[];
  },
  "DepArr"
>;

type Root = ModelType<
  {
    name: string;
  },
  "Root"
>;

const Dep = buildModelClass<Dep>("DepArr", { items: "list" });
const Root = buildModelClass<Root>("Root", { name: "val" });

describe("Dependencies – Array Bypass (Red)", () => {
  let depDoc: Y.Doc;
  let rootDoc: Y.Doc;
  let depId: string;

  beforeEach(() => {
    depDoc = new Y.Doc();
    rootDoc = new Y.Doc();
    primeDoc(depDoc);
    primeDoc(rootDoc);

    const d = new Dep({ items: ["a"] });
    const [id] = (d as any)[referenceSymbol](depDoc);
    depId = id;

    const r = new Root({ name: "root" });
    (r as any)[referenceSymbol](rootDoc);
    storeAsRoot(rootDoc, r as any);
  });

  it("Array.prototype.push.call should not mutate dependency list (expected red)", () => {
    load<Root>(rootDoc, { dep: depDoc });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const view = resolve(depId, "dep");

    // Bypass any overridden methods on the array instance
    expect(() => {
      Array.prototype.push.call((view as any).items, "bypass");
    }).toThrow();

    // Desired: still immutable; current behavior: mutation succeeds
    expect((view as any).items.includes("bypass")).toBe(false);
  });
});
