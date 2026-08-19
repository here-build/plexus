import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { C, resetCounters, withCounterWindow } from "../bench/counters.js";
import {
  getNodesYArray,
  observePlexusText,
  textEventsToReplaces,
  type TextEvent,
} from "../events.js";
import { addMark, insertTextAt, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * P1 event stream — Y.Array observe → TextEvent vocabulary + geometry shadow.
 */

function peerFrom(a: Y.Doc): { doc: Y.Doc; root: PlexusText } {
  const docB = new Y.Doc({ guid: a.guid });
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(a));
  return { doc: docB, root: connectTestPlexus<PlexusText>(docB).root };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("getNodesYArray", () => {
  it("resolves the Y.Array backing text.nodes on a doc-connected root", () => {
    const { root } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(root, 0, "hi");
    const arr = getNodesYArray(root);
    expect(arr).toBeTruthy();
    expect(arr!.length).to.equal(root.nodes.length);
  });
});

describe("observePlexusText — remote deltas", () => {
  it("1-char remote mid-insert → atoms-inserted with correct offset/text; no resync", () => {
    const { doc: docA, root: rootA } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(rootA, 0, "hello");

    const batches: TextEvent[][] = [];
    const dispose = observePlexusText(rootA, (evs) => {
      batches.push(evs);
    });
    expect(dispose).toBeTypeOf("function");

    const { doc: docB, root: rootB } = peerFrom(docA);
    insertTextAt(rootB, 2, "X"); // hello → heXllo
    sync(docA, docB);

    expect(toText(rootA)).to.equal("heXllo");
    const flat = batches.flat();
    expect(flat.some((e) => e.type === "resync")).to.equal(false);
    const ins = flat.filter((e) => e.type === "atoms-inserted") as Extract<
      TextEvent,
      { type: "atoms-inserted" }
    >[];
    expect(ins.length).to.be.greaterThan(0);
    expect(ins[0]).to.deep.equal({ type: "atoms-inserted", offset: 2, text: "X" });

    dispose!();
  });

  it("two-site concurrent inserts → multi-event batch (or multi-hunk equivalent)", () => {
    const { doc: docA, root: rootA } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(rootA, 0, "xxxx");

    const batches: TextEvent[][] = [];
    const dispose = observePlexusText(rootA, (evs) => batches.push(evs));

    const { doc: docB, root: rootB } = peerFrom(docA);
    // Concurrent: A inserts at start, B at end — no sync between.
    insertTextAt(rootA, 0, "A");
    insertTextAt(rootB, 4, "Z");
    // Deliver B→A only (A already has local A)
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    expect(toText(rootA)).to.equal("AxxxxZ");
    const flat = batches.flat();
    // Local insert may or may not be observed (same site) — remote Z must appear.
    const inserts = flat.filter((e) => e.type === "atoms-inserted") as Extract<
      TextEvent,
      { type: "atoms-inserted" }
    >[];
    const hasZ = inserts.some((e) => e.text.includes("Z"));
    expect(hasZ).to.equal(true);
    expect(flat.some((e) => e.type === "resync")).to.equal(false);

    dispose!();
  });

  it("dispose stops further events", () => {
    const { doc: docA, root: rootA } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(rootA, 0, "ab");

    let count = 0;
    const dispose = observePlexusText(rootA, () => {
      count++;
    });
    expect(dispose).toBeTruthy();
    dispose!();

    const before = count;
    const { doc: docB, root: rootB } = peerFrom(docA);
    insertTextAt(rootB, 1, "X");
    sync(docA, docB);
    expect(toText(rootA)).to.equal("aXb");
    expect(count).to.equal(before);
  });

  it("marker insert emits markers-changed (no text atom event for the marker)", () => {
    const { root } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(root, 0, "hi");

    const batches: TextEvent[][] = [];
    const dispose = observePlexusText(root, (evs) => batches.push(evs));
    addMark(root, 0, 2, "bold");

    const flat = batches.flat();
    expect(flat.some((e) => e.type === "markers-changed")).to.equal(true);
    // No atoms-inserted for zero-width markers
    const badAtom = flat.some((e) => e.type === "atoms-inserted" && e.text === "");
    expect(badAtom).to.equal(false);

    dispose!();
  });

  it("textEventsToReplaces maps insert/delete in sequential model coords", () => {
    const { replaces, resync } = textEventsToReplaces([
      { type: "atoms-inserted", offset: 2, text: "X" },
      { type: "atoms-removed", from: 4, to: 5 },
    ]);
    expect(resync).to.equal(false);
    // Offsets already sequential (post-prior-event); apply in order, no extra shift.
    expect(replaces[0]).to.deep.equal({ from: 2, to: 2, insert: "X" });
    expect(replaces[1]).to.deep.equal({ from: 4, to: 5, insert: "" });
  });
});

describe("observePlexusText — counters", () => {
  it("increments p1Events on delivery when C.on", () => {
    const { doc: docA, root: rootA } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(rootA, 0, "hello");
    const dispose = observePlexusText(rootA, () => {});

    const { delta } = withCounterWindow(() => {
      const { doc: docB, root: rootB } = peerFrom(docA);
      insertTextAt(rootB, 2, "X");
      sync(docA, docB);
    });

    expect(delta.p1Events).to.be.greaterThan(0);
    expect(delta.p1Resyncs).to.equal(0);
    dispose!();
    resetCounters();
    C.on = false;
  });
});
