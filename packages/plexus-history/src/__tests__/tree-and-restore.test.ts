import { encodePlexusUUID } from "@here.build/plexus/internals";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";

import { captureCut } from "../capture.js";
import { InMemoryCutLog } from "../cut-log.js";
import { changesBetween, changesByRef } from "../lift.js";
import { blame, decorate, subtreeScope } from "../operators.js";
import { currentValue, valueAtRef } from "../point-in-time.js";
import { applyRestore, planRestore } from "../restore.js";
import { ancestorChain } from "../tree.js";
import type { PlexusChange } from "../types.js";

const NUL = String.fromCharCode(0); // Plexus PlexusWrapper.PARENT_ATTR (U+0000)

// Plexus stores the `\0` parent as a tuple (array) attribute value; XmlElement.setAttribute
// is typed (string,string), so cast — exactly as PlexusWrapper.setParentData does.
const setAttr = (el: Y.XmlElement, k: string, v: unknown): void =>
  (el.setAttribute as (k: string, v: unknown) => void)(k, v);

function uuidOf(el: Y.XmlElement): string {
  const item = (el as unknown as { _item: { id: { client: number; clock: number } } })._item;
  return encodePlexusUUID(item.id.client, item.id.clock);
}

/**
 * A nested VFS-shaped tree with a rename and a reparent:
 *   cut0 root/  cut1 src/  cut2 lib/  cut3 file(util.ts) under src
 *   cut4 rename file → utils.ts (still under src)   cut5 reparent file src → lib
 */
function setup() {
  const doc = new Y.Doc({ gc: false });
  const types = doc.getMap("types");
  const log = new InMemoryCutLog();
  doc.on("update", (_u, _o, _d, tr) => {
    const seq = (log.latest()?.seq ?? -1) + 1;
    log.append(captureCut(tr, { seq, timestamp: seq, author: null }));
  });

  let root!: Y.XmlElement;
  let src!: Y.XmlElement;
  let lib!: Y.XmlElement;
  let file!: Y.XmlElement;
  doc.transact(() => {
    root = new Y.XmlElement("Dir");
    types.set("root", root);
    root.setAttribute("name", "/");
  });
  doc.transact(() => {
    src = new Y.XmlElement("Dir");
    types.set("src", src);
    setAttr(src, NUL, [uuidOf(root), "children"]);
    src.setAttribute("name", "src");
  });
  doc.transact(() => {
    lib = new Y.XmlElement("Dir");
    types.set("lib", lib);
    setAttr(lib, NUL, [uuidOf(root), "children"]);
    lib.setAttribute("name", "lib");
  });
  doc.transact(() => {
    file = new Y.XmlElement("File");
    types.set("file", file);
    setAttr(file, NUL, [uuidOf(src), "children"]);
    file.setAttribute("name", "util.ts");
  });
  doc.transact(() => file.setAttribute("name", "utils.ts"));
  doc.transact(() => setAttr(file, NUL, [uuidOf(lib), "children"]));

  return { doc, log, ids: { root: uuidOf(root), src: uuidOf(src), lib: uuidOf(lib), file: uuidOf(file) } };
}

function allChanges(s: ReturnType<typeof setup>): PlexusChange[] {
  const head = s.log.latest()!;
  return changesBetween(s.doc, null, head, s.log.range(0, head.seq));
}

describe("ancestorChain", () => {
  test("current tree: [file, lib, root] after the reparent", () => {
    const { doc, ids } = setup();
    expect(ancestorChain(doc, ids.file).map((r) => r.uuid)).toEqual([ids.file, ids.lib, ids.root]);
  });

  test("as-of-cut respects the reparent: [file, src, root] at cut 4 (before the move)", () => {
    const { doc, log, ids } = setup();
    const chain = ancestorChain(doc, ids.file, log.get(4), log.range(0, 4));
    expect(chain.map((r) => r.uuid)).toEqual([ids.file, ids.src, ids.root]);
  });
});

describe("subtreeScope as-of-cut", () => {
  test("keeps the in-src rename that current-tree wrongly drops", () => {
    const s = setup();
    const all = allChanges(s);
    const renamedInScope = (cs: PlexusChange[]) =>
      cs.some((c) => c.verb === "set" && c.field === "name" && c.entity.uuid === s.ids.file && c.after === "utils.ts");

    // current-tree: file is NOW under lib, so its in-src rename is (wrongly) excluded from src scope
    expect(renamedInScope(subtreeScope(all, [s.ids.src], s.doc))).toBe(false);
    // as-of-cut: the rename happened while file was under src → correctly kept
    expect(renamedInScope(subtreeScope(all, [s.ids.src], s.doc, { cutLog: s.log }))).toBe(true);
  });

  test("keeps the moved-out reparent as a boundary event of src", () => {
    const s = setup();
    const scoped = subtreeScope(allChanges(s), [s.ids.src], s.doc, { cutLog: s.log });
    expect(scoped.some((c) => c.verb === "reparent" && c.entity.uuid === s.ids.file)).toBe(true);
  });
});

describe("decorate", () => {
  test("fills entity.label via the resolver", () => {
    const s = setup();
    const labeled = decorate(allChanges(s), (ref) => `${ref.type}:${ref.uuid.slice(0, 4)}`);
    expect(labeled.every((c) => typeof c.entity.label === "string")).toBe(true);
  });
});

describe("planRestore", () => {
  test("restores the ownership pointer (reparent) to the cut-4 parent", () => {
    const { doc, log, ids } = setup();
    const plan = planRestore(doc, [{ uuid: ids.file, type: "File", parent: true }], log.get(4)!, log.range(0, 4));
    const reparent = plan.find((p) => p.verb === "reparent" && p.entity.uuid === ids.file);
    expect(reparent?.to?.uuid).toBe(ids.src); // restore to src (where it was at cut 4)
    expect(reparent?.from?.uuid).toBe(ids.lib); // from current (lib)
  });

  test("restores a scalar field", () => {
    const { doc, log, ids } = setup();
    const plan = planRestore(doc, [{ uuid: ids.file, type: "File", fields: ["name"] }], log.get(3)!, log.range(0, 3));
    expect(plan).toMatchObject([{ verb: "set", field: "name", before: "utils.ts", after: "util.ts" }]);
  });
});

describe("applyRestore", () => {
  test("round-trips a scalar field: plan then apply restores the value", () => {
    const { doc, log, ids } = setup();
    const plan = planRestore(doc, [{ uuid: ids.file, type: "File", fields: ["name"] }], log.get(3)!, log.range(0, 3));
    applyRestore(doc, plan);
    expect(currentValue(doc, ids.file, "name")).toBe("util.ts"); // was "utils.ts" at HEAD
  });

  test("round-trips the ownership pointer: file moves back under src", () => {
    const { doc, log, ids } = setup();
    const plan = planRestore(doc, [{ uuid: ids.file, type: "File", parent: true }], log.get(4)!, log.range(0, 4));
    applyRestore(doc, plan);
    expect(ancestorChain(doc, ids.file).map((r) => r.uuid)).toEqual([ids.file, ids.src, ids.root]);
  });
});

describe("conveniences", () => {
  test("valueAtRef resolves a ref via the cutLog", () => {
    const { doc, log, ids } = setup();
    expect(valueAtRef(doc, log, ids.file, "name", 3)).toBe("util.ts");
    expect(valueAtRef(doc, log, ids.file, "name", "HEAD")).toBe("utils.ts");
  });

  test("changesByRef matches the low-level form", () => {
    const s = setup();
    expect(changesByRef(s.doc, s.log, null, "HEAD").length).toBe(allChanges(s).length);
  });

  test("blame: last writer per field", () => {
    const { doc, log, ids } = setup();
    expect(blame(doc, log, ids.file).get("name")?.after).toBe("utils.ts");
  });
});
