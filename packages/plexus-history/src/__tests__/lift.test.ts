import { encodePlexusUUID } from "@here.build/plexus/internals";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";

import { captureCut } from "../capture.js";
import { changesBetween } from "../lift.js";
import type { Cut } from "../types.js";
import { MissingStructError } from "../types.js";

// Plexus PlexusWrapper.PARENT_ATTR (U+0000) - the ownership-pointer attribute key.
const NUL = String.fromCharCode(0);

// uuid the lift computes for an entity XmlElement = encode of its own item id.
function uuidOf(el: Y.XmlElement): string {
  const item = (el as unknown as { _item: { id: { client: number; clock: number } } })._item;
  return encodePlexusUUID(item.id.client, item.id.clock);
}

function setup() {
  const doc = new Y.Doc({ gc: false });
  const types = doc.getMap("types");
  const cuts: Cut[] = [];
  doc.on("update", (_u, _o, _d, tr) => cuts.push(captureCut(tr, { seq: cuts.length, timestamp: cuts.length, author: null })));
  const frame = (i: number) => changesBetween(doc, cuts[i - 1] ?? null, cuts[i], [cuts[i]]);
  return { doc, types, cuts, frame };
}

describe("lift", () => {
  test("materialized + set (first-time, then overwrite with before/after + provenance)", () => {
    const { doc, types, frame } = setup();
    let btn!: Y.XmlElement;
    doc.transact(() => {
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
    });
    doc.transact(() => btn.setAttribute("fill", "#2563EB"));
    doc.transact(() => btn.setAttribute("fill", "#DC2626"));
    const uuid = uuidOf(btn);

    expect(frame(0)).toMatchObject([{ verb: "materialized", entity: { uuid, type: "Button" } }]);
    expect(frame(1)).toMatchObject([{ verb: "set", entity: { uuid }, field: "fill", after: "#2563EB" }]);

    const f2 = frame(2);
    expect(f2).toHaveLength(1);
    expect(f2[0]).toMatchObject({ verb: "set", field: "fill", before: "#2563EB", after: "#DC2626", seq: 2, author: null });
  });

  test("reparent (from to) + detach via the ownership pointer", () => {
    const { doc, types, frame } = setup();
    let btn!: Y.XmlElement;
    doc.transact(() => {
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
    });
    doc.transact(() => btn.setAttribute(NUL, ["cardA", "children"] as never));
    doc.transact(() => btn.setAttribute(NUL, ["cardB", "children"] as never));
    doc.transact(() => btn.removeAttribute(NUL));

    // C5: the child-list key (tuple[1]) rides in `field`.
    expect(frame(2)).toMatchObject([{ verb: "reparent", field: "children", from: { uuid: "cardA" }, to: { uuid: "cardB" } }]);
    expect(frame(3)).toMatchObject([{ verb: "detach", field: "children", from: { uuid: "cardB" } }]);
  });

  test("insert + remove on a list field", () => {
    const { doc, types, frame } = setup();
    let btn!: Y.XmlElement;
    let arr!: Y.Array<unknown>;
    doc.transact(() => {
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
      arr = new Y.Array();
      btn.setAttribute("kids", arr as never);
    });
    doc.transact(() => arr.push(["x"]));
    doc.transact(() => arr.delete(0, 1));
    const uuid = uuidOf(btn);

    expect(frame(1)).toMatchObject([{ verb: "insert", entity: { uuid }, field: "kids", after: "x" }]);
    expect(frame(2)).toMatchObject([{ verb: "remove", field: "kids", before: "x" }]);
  });

  test("reorder: same value removed + reinserted in one cut on a list → one reorder, not remove+insert (C3)", () => {
    const { doc, types, frame } = setup();
    let btn!: Y.XmlElement;
    let arr!: Y.Array<unknown>;
    doc.transact(() => {
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
      arr = new Y.Array();
      btn.setAttribute("kids", arr as never);
      arr.push(["a", "b", "c"]);
    });
    doc.transact(() => {
      arr.delete(0, 1); // remove "a" …
      arr.insert(2, ["a"]); // … and reinsert it at the end — one txn = a move
    });
    const uuid = uuidOf(btn);

    const f1 = frame(1);
    expect(f1).toHaveLength(1); // ONE reorder, not a remove + an insert
    expect(f1[0]).toMatchObject({ verb: "reorder", entity: { uuid }, field: "kids", after: "a" });
  });

  test("record/map entry: keyed set + overwrite (before/after) + clear, surfacing the entry key (C1+C2)", () => {
    const { doc, types, frame } = setup();
    let btn!: Y.XmlElement;
    let attrs!: Y.Map<unknown>;
    doc.transact(() => {
      btn = new Y.XmlElement("Button");
      types.set("b", btn);
      attrs = new Y.Map();
      btn.setAttribute("attrs", attrs as never); // a record/map-valued field
    });
    doc.transact(() => attrs.set("data-x", "v1"));
    doc.transact(() => attrs.set("data-x", "v2")); // overwrite the same key (insert + delete, same txn)
    doc.transact(() => attrs.delete("data-x"));
    const uuid = uuidOf(btn);

    // C2: the entry key is surfaced. C1: a same-key overwrite PAIRS into one `set` (was two unpaired insert/remove).
    expect(frame(1)).toMatchObject([{ verb: "set", entity: { uuid }, field: "attrs", key: "data-x", after: "v1" }]);
    const f2 = frame(2);
    expect(f2).toHaveLength(1);
    expect(f2[0]).toMatchObject({ verb: "set", field: "attrs", key: "data-x", before: "v1", after: "v2" });
    expect(frame(3)).toMatchObject([{ verb: "clear", field: "attrs", key: "data-x", before: "v2" }]);
  });

  test("MissingStructError when a cut references a struct the archive lacks", () => {
    const { doc, types, cuts } = setup();
    doc.transact(() => types.set("b", new Y.XmlElement("Button")));
    const bogus: Cut = {
      seq: 1,
      timestamp: 1,
      author: null,
      afterState: cuts[0].afterState,
      deletedRanges: new Map([[424242, [{ clock: 7, len: 1 }]]]),
    };
    expect(() => changesBetween(doc, cuts[0], bogus, [bogus])).toThrow(MissingStructError);
  });
});
