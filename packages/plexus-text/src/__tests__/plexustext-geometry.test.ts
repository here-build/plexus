import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { C, resetCounters, withCounterWindow } from "../bench/counters.js";
import { observePlexusText } from "../events.js";
import { addMark, insertTextAt, toText } from "../marker.js";
import {
  atomsFromString,
  isTextAtom,
  PlexusText,
  TextAtom,
} from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * N6 B2-lite: listIndexAtOffset prefix-sum geometry.
 * Pins O(log n) nodesScanned on the warm local path and mid-atom split semantics.
 */

function emptyText() {
  return new PlexusText({});
}

function fresh(seed = ""): PlexusText {
  const { root } = initTestPlexus<PlexusText>(emptyText());
  if (seed) insertTextAt(root, 0, seed);
  return root;
}

describe("N6 geometry — listIndexAtOffset", () => {
  it("matches linear semantics: insert at start/mid/end with markers", () => {
    const t = fresh("abcdefgh");
    addMark(t, 0, 1, "bold");
    addMark(t, 1, 2, "italic");
    addMark(t, 2, 3, "underline");
    // Char offset 6 between f and g — many marker embeds before it.
    insertTextAt(t, 6, "X");
    expect(toText(t)).to.equal("abcdefXgh");
  });

  it("offset 0 after a leading open marker inserts inside the mark (inherit)", () => {
    const t = fresh("world");
    addMark(t, 0, 5, "bold");
    insertTextAt(t, 0, "X");
    expect(toText(t)).to.equal("Xworld");
    // Open is still first; X after open → bold.
    const openIdx = t.nodes.findIndex((n) => !isTextAtom(n) && (n as { open: boolean }).open);
    const xIdx = t.nodes.findIndex((n) => isTextAtom(n) && n.text === "X");
    expect(openIdx).to.equal(0);
    expect(xIdx).to.be.greaterThan(openIdx);
  });

  it("boundary after atom before a marker: insert sits before the marker", () => {
    const t = fresh("ab");
    addMark(t, 1, 2, "bold"); // open between a|b
    // Sequence roughly: a, open, b, close. Offset 1 = after 'a'.
    const idx = t.listIndexAtOffset(1);
    // Should be the open marker's index (first node at char boundary 1).
    const n = t.nodes[idx];
    expect(n && !isTextAtom(n)).to.equal(true);
  });

  it("preserves mid-atom split for multi-code-unit atoms (emoji)", () => {
    // atomsFromString keeps 😀 as one length-2 atom.
    const t = fresh("😀ab");
    // Code-unit offset 1 is mid-surrogate — split is destructive by contract.
    const beforeNodes = t.nodes.length;
    t.listIndexAtOffset(1);
    // Split added a node.
    expect(t.nodes.length).to.equal(beforeNodes + 1);
    const left = t.nodes[0];
    expect(isTextAtom(left) && left.text.length === 1).to.equal(true);
  });

  it("past-end offset returns nodes.length", () => {
    const t = fresh("abc");
    expect(t.listIndexAtOffset(100)).to.equal(t.nodes.length);
    expect(t.listIndexAtOffset(3)).to.equal(t.nodes.length);
  });

  it("empty doc returns 0", () => {
    const t = fresh();
    expect(t.listIndexAtOffset(0)).to.equal(0);
  });

  it("warm listIndexAtOffset scans O(log n) nodes, not O(n)", () => {
    const N = 4_000;
    const t = fresh("x".repeat(N));
    // Prime the geometry cache (may pay O(n) rebuild once).
    t.listIndexAtOffset(N);
    resetCounters();
    C.on = true;
    try {
      // Mid-doc query on warm cache.
      t.listIndexAtOffset(Math.floor(N / 2));
      // Binary search ≤ log2(N) + small constant (marker walk / land).
      const logBound = Math.ceil(Math.log2(N)) + 8;
      expect(C.nodesScanned).to.be.lessThanOrEqual(logBound);
      expect(C.nodesScanned).to.be.lessThan(N / 10);
      expect(C.listIndexAtOffset).to.equal(1);
    } finally {
      C.on = false;
      resetCounters();
    }
  });

  it("repeated insertTextAt at mid keeps per-keystroke nodesScanned sublinear", () => {
    const N = 2_000;
    const t = fresh("a".repeat(N));
    // Warm
    insertTextAt(t, Math.floor(N / 2), "W");

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { delta } = withCounterWindow(() => {
        insertTextAt(t, Math.floor(N / 2) + i, "z");
      });
      samples.push(delta.nodesScanned);
    }
    const med = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    // Warm path: binary search only — far below linear in N.
    expect(med).to.be.lessThan(Math.ceil(Math.log2(N)) + 16);
    expect(med).to.be.lessThan(N / 20);
  });

  it("geo cache survives insert chain without full rebuild each time", () => {
    const t = fresh("hello");
    const { delta: d1 } = withCounterWindow(() => insertTextAt(t, 5, "1"));
    const { delta: d2 } = withCounterWindow(() => insertTextAt(t, 6, "2"));
    const { delta: d3 } = withCounterWindow(() => insertTextAt(t, 7, "3"));
    // First may rebuild (seed path); subsequent inserts must not re-scan all nodes.
    expect(d2.nodesScanned).to.be.lessThan(t.nodes.length);
    expect(d3.nodesScanned).to.be.lessThan(t.nodes.length);
    expect(toText(t)).to.equal("hello123");
    // Silence unused if first is large
    expect(d1.listIndexAtOffset).to.be.greaterThanOrEqual(1);
  });

  it("atomsFromString still prefers length-1 / surrogate-pair atoms (no multi-char runs)", () => {
    const atoms = atomsFromString("a😀b");
    expect(atoms.map((a) => a.text)).to.deep.equal(["a", "😀", "b"]);
    expect(atoms.every((a) => a instanceof TextAtom)).to.equal(true);
  });
});

describe("N6 geometry — remote P1 dirty", () => {
  it("after remote observe batch, listIndexAtOffset still lands correct mid insert", () => {
    const { doc: docA, root: rootA } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(rootA, 0, "a".repeat(200));
    // Warm local geo
    rootA.listIndexAtOffset(100);

    let saw = 0;
    const dispose = observePlexusText(rootA, () => {
      saw++;
    });
    expect(dispose).toBeTruthy();

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const rootB = connectTestPlexus<PlexusText>(docB).root;
    insertTextAt(rootB, 100, "X");
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    expect(saw).to.be.greaterThan(0);
    expect(toText(rootA)).to.equal("a".repeat(100) + "X" + "a".repeat(100));
    // Cache was dirtied by observe delivery — insert at 100 still correct
    insertTextAt(rootA, 100, "Y");
    expect(toText(rootA)[100]).to.equal("Y");
    dispose!();
  });
});
