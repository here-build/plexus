import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { buildModelClass } from "../proxy-runtime.js";
import type { ModelType } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { docDependencyResolverMap, load } from "../load.js";
import { primeDoc, storeAsRoot } from "./test-helpers.js";
import { createTrackedFunction } from "../tracking.js";

// Rich dependency entity for read-only mutation tests
type DepRich = ModelType<
  {
    label: string;
    readonly tags: Set<string>;
    readonly items: string[];
    readonly meta: Record<string, string>;
  },
  "DepRich"
>;

type Root = ModelType<
  {
    name: string;
    ref: DepRich | null;
    readonly list: DepRich[];
    readonly map: Record<string, DepRich>;
  },
  "Root"
>;

const DepRich = buildModelClass<DepRich>("DepRich", {
  label: "val",
  tags: "set",
  items: "list",
  meta: "record"
});

const Root = buildModelClass<Root>("Root", {
  name: "val",
  ref: "val",
  list: "list",
  map: "record"
});

describe("Dependencies – Edge Cases", () => {
  let depA: Y.Doc;
  let depB: Y.Doc;
  let rootDoc: Y.Doc;
  let depAId: string;

  beforeEach(() => {
    depA = new Y.Doc();
    depB = new Y.Doc();
    rootDoc = new Y.Doc();
    primeDoc(depA);
    primeDoc(depB);
    primeDoc(rootDoc);

    const a = new DepRich({ label: "A", tags: new Set(["x"]), items: ["i1"], meta: { k: "v" } });
    const [id] = (a as any)[referenceSymbol](depA);
    depAId = id;

    const root = new Root({ name: "root", ref: null, list: [], map: {} });
    (root as any)[referenceSymbol](rootDoc);
    storeAsRoot(rootDoc, root as any);
  });

  it("read-only dep manifestations: set/list/record mutators throw", () => {
    const root = load<Root>(rootDoc, { depA });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const dep = resolve(depAId, "depA");

    // Attach to root (val) for easy access
    root.ref = dep;
    const view = root.ref!;

    // Set
    expect(() => (view.tags as any).add("y")).toThrow();
    expect(() => (view.tags as any).delete("x")).toThrow();
    expect(() => (view.tags as any).clear()).toThrow();

    // List
    expect(() => (view.items as any).push("i2")).toThrow();
    expect(() => (view.items as any).splice(0, 1)).toThrow();
    expect(() => (view.items as any).assign(["z"]).toString()).toThrow();

    // Record
    expect(() => ((view.meta as any).foo = "bar")).toThrow();
    // Some JS engines may not throw on delete for frozen objects; verify immutability instead
    const before = (view.meta as any).k;
    // Attempt delete, ignore outcome
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    delete (view.meta as any).k;
    expect((view.meta as any).k).toBe(before);
  });

  it("root collections remain mutable with dep items", () => {
    const root = load<Root>(rootDoc, { depA });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const dep = resolve(depAId, "depA");

    root.list.push(dep);
    root.map["a"] = dep;

    expect(root.list.length).toBe(1);
    expect(root.map["a"]).toBeTruthy();
  });

  it("hot-swapping dependency mapping updates future derefs only", () => {
    // Initial mapping
    const root = load<Root>(rootDoc, { depA });
    const resolve1 = docDependencyResolverMap.get(rootDoc)!;

    root.ref = resolve1(depAId, "depA");
    const oldView = root.ref!;
    expect(oldView.label).toBe("A");

    // New dep doc with same entity id but different content
    const depANew = new Y.Doc();
    primeDoc(depANew);
    // Re-create model under same id
    const models = depANew.getMap<Y.Map<any>>("models");
    const map = new Y.Map<any>();
    map.set("__type__", "DepRich");  // Type is now stored in model itself
    map.set("label", "A2");
    map.set("tags", Y.Array.from(["x"]));
    map.set("items", Y.Array.from([]));
    map.set("meta", new Y.Map());
    models.set(depAId, map);

    // Hot-swap resolver mapping using load()
    load<Root>(rootDoc, { depA: depANew });

    // Previously held view remains old
    expect(oldView.label).toBe("A");
    // New deref reflects new mapping
    const newView = root.ref!;
    expect(newView.label).toBe("A2");
  });

  it("tracking does not react to dependency doc changes", async () => {
    const root = load<Root>(rootDoc, { depA });
    const resolve = docDependencyResolverMap.get(rootDoc)!;
    const dep = resolve(depAId, "depA");
    root.ref = dep;

    const changed = vi.fn();
    const tracker = createTrackedFunction(changed, () => root.ref?.label);
    expect(tracker()).toBe("A");

    // Change dependency doc directly
    const models = depA.getMap<Y.Map<any>>("models");
    models.get(depAId)!.set("label", "AX");

    // No notification should be triggered (dep not tracked via root doc)
    await new Promise((r) => setImmediate(r));
    expect(changed).not.toHaveBeenCalled();
  });

  it("load() without root metadata throws", () => {
    const badDoc = new Y.Doc();
    primeDoc(badDoc);
    expect(() => load<any>(badDoc)).toThrow(/missing root model id/i);
  });
});
