import { describe, expect, it } from "vitest";
import * as prng from "lib0/prng";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, segments, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * RED-TEAM convergence suite for PlexusText (Peritext-over-one-Y.Text, markers as embeds).
 *
 * Mission: BREAK Strong Eventual Consistency. The central claim under attack:
 *   after any concurrent op set + full sync, ALL peers converge to identical `toText`
 *   AND `segments` — no loss, no duplication, no divergence, no crash.
 *
 * VERDICT: the claim HOLDS for plain concurrent text/format edits (yjs carries convergence
 * for free; `segments`/`toText` are pure folds of the converged delta) — every adversarial
 * scenario below stays green.
 *
 * NOTE — the old minted-span collision is GONE. The earlier model minted a span id per call
 * (`${clientID ?? 0}-${counter}`) and `segments()` keyed its active-set by that id, so two
 * peers' first marks could share an id and collapse (the old Findings A/B). The new model has
 * no span field: a `Mark` is a first-class Plexus entity and its pairing key is `mark.uuid`,
 * the CRDT-derived `encode({clientId, clock})` of the Mark's own creation — globally unique by
 * construction. There is no id to hand-mint and no id to collide, so that whole falsification
 * class is dissolved by the model, not patched. What remains here is the positive proof that
 * concurrent overlapping `addMark`s converge with no mark loss, plus the general SEC survivors.
 */

function emptyText() {
  return new PlexusText({});
}
function seedOne(text: PlexusText, s: string): void {
  insertTextAt(text, 0, s);
}
/** Bidirectional sync — each peer learns exactly what the other has it doesn't. */
function syncBoth(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}
/** A peer cloned from `a`'s doc (shares guid + initial state), connected fresh. */
function clonePeer(a: Y.Doc): { doc: Y.Doc; root: PlexusText } {
  const docB = new Y.Doc({ guid: a.guid });
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(a));
  return { doc: docB, root: connectTestPlexus<PlexusText>(docB).root };
}

describe("RED-TEAM PlexusText convergence", () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // SURVIVORS — the impl held. Kept as adversarial regressions.
  // ─────────────────────────────────────────────────────────────────────────────

  // VECTOR 1: 3 peers, ring/gossip sync order (not a full broadcast).
  it("3 peers, ring sync order (A↔B, B↔C, C↔A ×2) — all converge", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "hello world");
    const B = clonePeer(A.doc);
    const C = clonePeer(A.doc);

    insertTextAt(A.root, 0, ">>");
    addMark(B.root, 6, 11, "bold");
    insertTextAt(C.root, 11, "<<");

    // Two ring passes for full propagation.
    for (let pass = 0; pass < 2; pass++) {
      syncBoth(A.doc, B.doc);
      syncBoth(B.doc, C.doc);
      syncBoth(C.doc, A.doc);
    }

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(toText(B.root)).to.equal(toText(C.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
    expect(segments(B.root)).to.deep.equal(segments(C.root));
  });

  // VECTOR 2: delete swallows ONLY the close marker — orphaned open must be identical on peers.
  it("delete removes only the close marker (orphan open) — peers agree", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "hello world");
    addMark(A.root, 6, 9, "bold"); // close at offset 9
    const B = clonePeer(A.doc);

    deleteTextRange(A.root, 8, 11); // swallows the close embed; open survives → runs to end
    insertTextAt(B.root, 11, "!!");
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
  });

  // VECTOR 2b: delete swallows ONLY the open marker — dangling close must be identical on peers.
  it("delete removes only the open marker (dangling close) — peers agree", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "hello world");
    addMark(A.root, 6, 11, "bold");
    const B = clonePeer(A.doc);

    deleteTextRange(A.root, 5, 7); // swallows the open embed
    insertTextAt(B.root, 0, "X");
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
  });

  // VECTOR 3: same-range delete on both peers + a concurrent mark elsewhere.
  it("same-range delete on both peers + concurrent mark — converge, no double-delete", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "hello world");
    const B = clonePeer(A.doc);

    deleteTextRange(A.root, 6, 11); // both delete "world"
    deleteTextRange(B.root, 6, 11);
    addMark(B.root, 0, 5, "bold"); // B also bolds "hello"
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(toText(A.root)).to.equal("hello "); // deletes collapse to one; the space stays
    expect(segments(A.root)).to.deep.equal(segments(B.root));
  });

  // VECTOR 4: two peers insert AT the same marker boundary position.
  it("two peers insert AT the same marker boundary — converge, no torn span", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "abcdef");
    addMark(A.root, 2, 4, "bold");
    const B = clonePeer(A.doc);

    insertTextAt(A.root, 2, "AA");
    insertTextAt(B.root, 2, "BB");
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
  });

  // VECTOR 5: partition + heal — 24 divergent random ops each, no sync, then heal.
  it("partition/heal: 24 random divergent ops each, no sync, then heal — converge", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "the quick brown fox jumps");
    const B = clonePeer(A.doc);

    const genA = prng.create(0xdead);
    const genB = prng.create(0xbeef);
    const MARKS = ["bold", "italic", "underline", "link"] as const;
    function ops(gen: prng.PRNG, t: PlexusText, n: number) {
      for (let i = 0; i < n; i++) {
        const len = toText(t).length;
        const kind = prng.int32(gen, 0, 2);
        if (kind === 0 || len < 3) {
          insertTextAt(t, prng.int32(gen, 0, len), prng.word(gen, 1, 5));
        } else if (kind === 1) {
          const from = prng.int32(gen, 0, len - 2);
          const to = prng.int32(gen, from + 1, len);
          addMark(t, from, to, prng.oneOf(gen, [...MARKS]), prng.word(gen, 1, 3));
        } else {
          const from = prng.int32(gen, 0, len - 2);
          const to = prng.int32(gen, from + 1, len);
          deleteTextRange(t, from, to);
        }
      }
    }
    ops(genA, A.root, 24);
    ops(genB, B.root, 24);
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
  });

  // VECTOR 6: one peer deletes the WHOLE marked range (both markers) while the other inserts inside.
  it("delete the whole marked range (both markers) vs insert-inside — converge, insert survives", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "hello world");
    addMark(A.root, 6, 11, "bold");
    const B = clonePeer(A.doc);

    deleteTextRange(A.root, 5, 11); // both markers gone
    insertTextAt(B.root, 8, "ZZ"); // orphaned insert inside the dying range
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
    expect(toText(A.root)).to.contain("ZZ"); // the insert outlives its deleted neighbours
  });

  // VECTOR 9: crossing spans, concurrent delete severs one close.
  it("crossing spans (bold[0,5) × italic[2,7)), concurrent delete severs one close — converge", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "abcdefgh");
    addMark(A.root, 0, 5, "bold");
    addMark(A.root, 2, 7, "italic");
    const B = clonePeer(A.doc);

    deleteTextRange(A.root, 4, 6);
    insertTextAt(B.root, 3, "QQ");
    syncBoth(A.doc, B.doc);

    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));
  });

  // VECTOR 8: ORACLE SOUNDNESS — the differential oracle is NOT vacuous.
  it("ORACLE SANITY: a planted divergence is caught by deep.equal on segments", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "abc");
    addMark(A.root, 0, 3, "bold");
    const B = clonePeer(A.doc);
    insertTextAt(B.root, 0, "ZZZ"); // diverge B WITHOUT syncing
    expect(segments(A.root)).to.not.deep.equal(segments(B.root));
    expect(toText(A.root)).to.not.equal(toText(B.root));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // THE MODEL, PROVEN GREEN — the exact concurrent shape the old span-collision Findings
  // forced into a collision now converges by construction. A `Mark`'s pairing key is its
  // derived CRDT-UUID (`encode({clientId, clock})`), globally unique with no id to mint or
  // collide. Two peers each addMark overlapping marks (same-type AND different-type), full
  // sync → identical `toText` AND `segments`, with NO mark loss.
  // ─────────────────────────────────────────────────────────────────────────────
  it("two peers addMark overlapping marks (derived UUID refs) → converge, no mark loss", () => {
    const A = initTestPlexus<PlexusText>(emptyText());
    seedOne(A.root, "abcdef");
    const B = clonePeer(A.doc);

    // A: bold[0,4), then an OVERLAPPING same-type bold[1,3). B: italic[2,6) (different type,
    // overlaps A's bold) and underline[3,5). This is the shape the old Findings forced into a
    // collision; with each Mark's derived UUID as the ref, every open/close pair has its own
    // key, so no active-set entry is ever stolen.
    addMark(A.root, 0, 4, "bold");
    addMark(B.root, 2, 6, "italic");
    addMark(A.root, 1, 3, "bold"); // same-type overlap on A
    addMark(B.root, 3, 5, "underline"); // different-type overlap on B
    syncBoth(A.doc, B.doc);

    // SEC holds: the two peers are byte-identical on both projections.
    expect(toText(A.root)).to.equal(toText(B.root));
    expect(segments(A.root)).to.deep.equal(segments(B.root));

    // No mark loss: every type that was applied is present somewhere in the converged segments.
    const allMarkKeys = new Set(segments(A.root).flatMap((s) => Object.keys(s.marks)));
    expect(allMarkKeys).to.deep.equal(new Set(["bold", "italic", "underline"]));

    // And the overlap carries the union of marks — no span silently dropped another's coverage.
    expect(segments(A.root)).to.deep.equal([
      { text: "ab", marks: { bold: true } },
      { text: "c", marks: { bold: true, italic: true } },
      { text: "d", marks: { bold: true, italic: true, underline: true } },
      { text: "e", marks: { italic: true, underline: true } },
      { text: "f", marks: { italic: true } },
    ]);
  });
});
