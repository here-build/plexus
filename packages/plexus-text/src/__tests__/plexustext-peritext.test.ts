import { describe, expect, it } from "vitest";
import * as prng from "lib0/prng";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, type Segment, segments, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * CONCURRENCY / CONVERGENCE conformance — the Ink & Switch *Peritext* scenarios adapted to
 * this embed model (one Y.Text, markers as `{type,value,open,span}` embeds).
 *
 * Two assertion modes, both grounded in the differential oracle of plexustext-differential.ts:
 *
 *   1. distributed == local  — the LOCAL sequential run is ground truth; a DISTRIBUTED run
 *      (two peers edit concurrently, then `syncBoth`) must reproduce it on BOTH `toText` and
 *      `segments`. This catches loss/duplication AND mark mis-attribution, not just agreement.
 *
 *   2. peers AGREE (SEC)      — for op-orders with a legitimate CRDT resolution that need not
 *      match a sequential order, the load-bearing property is Strong Eventual Consistency:
 *      after a full bidirectional sync the two peers project to the SAME `segments`.
 *
 * KNOWN DEFERRALS (not chased as bugs):
 *  (a) concurrent OVERLAPPING *exclusive* marks with DIFFERENT values (two link hrefs / colors
 *      on one range) resolve by sequence-position, NOT Lamport opId — so distributed may differ
 *      from local for that one case. Tested below as `it.fails` ("deferred: opId LWW").
 *  (b) overlapping COMMENTS as a set are a separate annotation channel — out of scope here.
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

/** A second peer cloned from `a`'s doc (shares guid + initial state), connected fresh. */
function clonePeer(a: Y.Doc): { doc: Y.Doc; root: PlexusText } {
  const docB = new Y.Doc({ guid: a.guid });
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(a));
  return { doc: docB, root: connectTestPlexus<PlexusText>(docB).root };
}

/**
 * Run a scenario LOCALLY (sequential = ground truth) and DISTRIBUTED (two concurrent peers,
 * then `syncBoth`). Returns both representations of each so callers assert on toText AND
 * segments. Mirrors `differential()` in plexustext-differential.ts, extended to segments.
 */
function differential(
  seed: string,
  local: (text: PlexusText) => void,
  a: (text: PlexusText) => void,
  b: (text: PlexusText) => void,
) {
  const ref = initTestPlexus<PlexusText>(emptyText());
  seedOne(ref.root, seed);
  local(ref.root);

  const peerA = initTestPlexus<PlexusText>(emptyText());
  seedOne(peerA.root, seed);
  const { doc: docB, root: rootB } = clonePeer(peerA.doc);

  a(peerA.root);
  b(rootB);
  syncBoth(peerA.doc, docB);

  return {
    expText: toText(ref.root),
    expSegs: segments(ref.root),
    aText: toText(peerA.root),
    bText: toText(rootB),
    aSegs: segments(peerA.root),
    bSegs: segments(rootB),
  };
}

/** Assert a distributed run reproduced the local ground truth on both peers (text + segments). */
function expectMatchesLocal(d: ReturnType<typeof differential>): void {
  // Peers agree (SEC) first — a divergence here is a real correctness bug.
  expect(d.aText).to.equal(d.bText);
  expect(d.aSegs).to.deep.equal(d.bSegs);
  // …and they agree with the sequential ground truth (no loss / duplication / mis-attribution).
  expect(d.aText).to.equal(d.expText);
  expect(d.bText).to.equal(d.expText);
  expect(d.aSegs).to.deep.equal(d.expSegs);
  expect(d.bSegs).to.deep.equal(d.expSegs);
}

/** True iff some run in `segs` carries `type` (with any value). */
function hasMark(segs: Segment[], type: string): boolean {
  return segs.some((s) => type in s.marks);
}

/** The marks covering the run that contains substring `needle` (first match). */
function marksOver(segs: Segment[], needle: string): Segment["marks"] | undefined {
  return segs.find((s) => s.text.includes(needle))?.marks;
}

describe("PlexusText Peritext — concurrency / convergence conformance", () => {
  // ── 1. Concurrent plain inserts at different positions ──────────────────────────
  it("concurrent inserts at different positions — both survive, converge", () => {
    const d = differential(
      "hello world",
      (t) => {
        // local sequential order matches the CRDT tie-break: A's edit, then B's.
        insertTextAt(t, 0, ">>");
        insertTextAt(t, 13, "<<"); // 11 + 2 from the ">>" already present locally
      },
      (t) => insertTextAt(t, 0, ">>"), // prepend
      (t) => insertTextAt(t, 11, "<<"), // append
    );
    // Both inserts survive; order of disjoint inserts is deterministic under yjs.
    expect(d.aText).to.equal(d.bText);
    expect(d.aText).to.equal(">>hello world<<");
    expect(d.aSegs).to.deep.equal(d.bSegs);
  });

  // ── 2. Concurrent format + insert INSIDE the formatted range ────────────────────
  it("insert inside a concurrently-marked range inherits the mark (span grows)", () => {
    // Peer A bolds "world" [6,11); Peer B inserts "big " at offset 8 (inside "world": wo|rld).
    const d = differential(
      "hello world",
      (t) => {
        addMark(t, 6, 11, "bold");
        insertTextAt(t, 8, "big ");
      },
      (t) => addMark(t, 6, 11, "bold"),
      (t) => insertTextAt(t, 8, "big "),
    );
    expect(d.aText).to.equal("hello wobig rld");
    expectMatchesLocal(d);
    // The inserted text is INSIDE the span → it is bold on both peers.
    expect(marksOver(d.aSegs, "big")).to.deep.equal({ bold: true });
    expect(marksOver(d.bSegs, "big")).to.deep.equal({ bold: true });
  });

  // ── 3. Overlapping bold + bold (same type, same value) ──────────────────────────
  it("overlapping bold + bold (same value) — union is bold, no doubling", () => {
    // A bolds [0,6), B bolds [3,9) of "abcdefghi". Union [0,9) is uniformly bold.
    const d = differential(
      "abcdefghi",
      (t) => {
        addMark(t, 0, 6, "bold");
        addMark(t, 3, 9, "bold");
      },
      (t) => addMark(t, 0, 6, "bold"),
      (t) => addMark(t, 3, 9, "bold"),
    );
    expect(d.aText).to.equal("abcdefghi");
    // peers agree
    expect(d.aSegs).to.deep.equal(d.bSegs);
    // every char [0,9) is bold; nothing carries a doubled/odd mark
    expect(d.aSegs.every((s) => s.marks.bold === true)).to.equal(true);
    expect(d.aSegs.map((s) => s.text).join("")).to.equal("abcdefghi");
    // the whole thing is one uniform bold value — same as local ground truth
    expect(d.aSegs).to.deep.equal(d.expSegs);
  });

  // ── 4. Overlapping bold + italic (different types) ──────────────────────────────
  it("overlapping bold + italic — the intersection carries both", () => {
    // A bolds [0,4), B italicizes [2,6) of "abcdef". [2,4) intersection = {bold, italic}.
    const d = differential(
      "abcdef",
      (t) => {
        addMark(t, 0, 4, "bold");
        addMark(t, 2, 6, "italic");
      },
      (t) => addMark(t, 0, 4, "bold"),
      (t) => addMark(t, 2, 6, "italic"),
    );
    expect(d.aSegs).to.deep.equal(d.bSegs);
    // "cd" is the [2,4) intersection — both marks present on both peers.
    expect(marksOver(d.aSegs, "cd")).to.deep.equal({ bold: true, italic: true });
    expect(marksOver(d.bSegs, "cd")).to.deep.equal({ bold: true, italic: true });
    // both mark types survive
    expect(hasMark(d.aSegs, "bold")).to.equal(true);
    expect(hasMark(d.aSegs, "italic")).to.equal(true);
  });

  // ── 5. Delete a marked range on one peer vs. edit inside it on the other ─────────
  it("concurrent delete-of-marked-range vs edit-inside — converges, sane segments", () => {
    // "hello world": A bolds "world" [6,11) then deletes [6,11). B inserts "X" at 8 (inside).
    // Surviving char from B's insert remains; no crash; peers agree.
    const peerA = initTestPlexus<PlexusText>(emptyText());
    seedOne(peerA.root, "hello world");
    addMark(peerA.root, 6, 11, "bold");
    const { doc: docB, root: rootB } = clonePeer(peerA.doc);

    deleteTextRange(peerA.root, 6, 11); // delete the whole bolded "world"
    insertTextAt(rootB, 8, "X"); // concurrent insert inside the (about-to-be-deleted) range
    syncBoth(peerA.doc, docB);

    // SEC: peers converge.
    expect(toText(peerA.root)).to.equal(toText(rootB));
    expect(segments(peerA.root)).to.deep.equal(segments(rootB));
    // No crash, projection is well-formed (every run has a string).
    for (const s of segments(peerA.root)) expect(typeof s.text).to.equal("string");
    // The concurrently-inserted "X" survives the delete of its neighbours.
    expect(toText(peerA.root)).to.contain("X");
  });

  // ── 6. Two peers addMark of the SAME type+range concurrently ────────────────────
  it("concurrent identical addMark (same type+range) — converges deterministically", () => {
    // Both peers independently bold [0,5) of "hello world". Duplicate spans, one visible result.
    const d = differential(
      "hello world",
      (t) => addMark(t, 0, 5, "bold"), // local: a single mark
      (t) => addMark(t, 0, 5, "bold"),
      (t) => addMark(t, 0, 5, "bold"),
    );
    // peers agree (SEC) — the two duplicate spans project identically.
    expect(d.aText).to.equal(d.bText);
    expect(d.aSegs).to.deep.equal(d.bSegs);
    // "hello" is bold, " world" is not — same shape as a single mark.
    expect(d.aSegs).to.deep.equal([
      { text: "hello", marks: { bold: true } },
      { text: " world", marks: {} },
    ]);
    // …and that equals the local single-mark ground truth — no doubling artifact.
    expect(d.aSegs).to.deep.equal(d.expSegs);
  });

  // ── (deferred a) overlapping EXCLUSIVE marks, DIFFERENT values ──────────────────
  // Two different link hrefs over the same range resolve by Yjs item ordering (the clientID
  // tie-break at the shared position), NOT by Lamport opId / causal order — so the DISTRIBUTED
  // winner can differ from the LOCAL (sequential) winner. Verified empirically: the distributed
  // winner is the marker with the higher-clientID author, regardless of who authored "first".
  //
  // We make the divergence DETERMINISTIC (not a clientID coin-flip): after observing the
  // distributed winner, we build the local ground truth so its sequential order makes the OTHER
  // value win (last-applied = innermost = wins). distributed != local then holds every run.
  it.fails("overlapping link A vs link B on same range — distributed == local (deferred: opId LWW)", () => {
    // distributed run: A authors "A", B authors "B" concurrently over [0,6).
    const peerA = initTestPlexus<PlexusText>(emptyText());
    seedOne(peerA.root, "abcdef");
    const { doc: docB, root: rootB } = clonePeer(peerA.doc);
    addMark(peerA.root, 0, 6, "link", "A");
    addMark(rootB, 0, 6, "link", "B");
    syncBoth(peerA.doc, docB);
    const distWinner = segments(peerA.root)[0]?.marks.link as string;

    // local ground truth: apply both sequentially so the DISTRIBUTED LOSER wins locally
    // (innermost = applied last). This forces local != distributed deterministically.
    const localLast = distWinner === "A" ? "B" : "A";
    const localFirst = distWinner === "A" ? "A" : "B";
    const ref = initTestPlexus<PlexusText>(emptyText());
    seedOne(ref.root, "abcdef");
    addMark(ref.root, 0, 6, "link", localFirst);
    addMark(ref.root, 0, 6, "link", localLast); // localLast (the dist loser) wins locally

    // SEC still holds across peers (this leg passes); the distributed==local leg is the one
    // that legitimately fails — distWinner is the higher-clientID author, not the local order.
    expect(segments(peerA.root)).to.deep.equal(segments(rootB)); // SEC holds
    expect(segments(peerA.root)).to.deep.equal(segments(ref.root)); // FAILS — the deferral
  });

  // Companion to the deferral: SEC must STILL hold even though the value is undetermined.
  it("overlapping link A vs link B on same range — peers still AGREE (SEC holds)", () => {
    const d = differential(
      "abcdef",
      (t) => {
        addMark(t, 0, 6, "link", "A");
        addMark(t, 0, 6, "link", "B");
      },
      (t) => addMark(t, 0, 6, "link", "A"),
      (t) => addMark(t, 0, 6, "link", "B"),
    );
    // text never diverges; the projection agrees; the single `link` value is some {A|B}.
    expect(d.aText).to.equal(d.bText);
    expect(d.aSegs).to.deep.equal(d.bSegs);
    const v = marksOver(d.aSegs, "abc")?.link;
    expect(v === "A" || v === "B").to.equal(true);
  });

  // ── 7. Longer randomized sequence — SEC under N concurrent ops ──────────────────
  // Seeded with lib0/prng for reproducibility; assert peers AGREE on segments after sync.
  // SEC is the load-bearing invariant; we do NOT assert against a sequential ground truth
  // here because random interleavings have legitimate CRDT resolutions that need not match
  // any one sequential order.
  describe("randomized convergence (SEC) — peers agree after full sync", () => {
    const MARK_TYPES = ["bold", "italic", "underline"] as const;

    function randomOp(gen: prng.PRNG, t: PlexusText): void {
      const len = toText(t).length;
      const kind = prng.int32(gen, 0, 3);
      if (kind === 0 || len < 2) {
        // insert
        const at = prng.int32(gen, 0, len);
        const word = prng.word(gen, 1, 4);
        insertTextAt(t, at, word);
      } else if (kind === 1) {
        // mark a random range
        const from = prng.int32(gen, 0, len - 1);
        const to = prng.int32(gen, from + 1, len);
        const type = prng.oneOf(gen, [...MARK_TYPES]);
        addMark(t, from, to, type);
      } else {
        // delete a random range
        const from = prng.int32(gen, 0, len - 1);
        const to = prng.int32(gen, from + 1, len);
        deleteTextRange(t, from, to);
      }
    }

    // A handful of seeds — each a full two-peer concurrent run.
    for (const seed of [1, 7, 42, 1337, 90210]) {
      it(`seed ${seed}: ${"N"} concurrent ops across two peers, then sync → peers agree`, () => {
        const genA = prng.create(seed);
        const genB = prng.create(seed ^ 0x9e3779b9); // a different stream for peer B

        const peerA = initTestPlexus<PlexusText>(emptyText());
        seedOne(peerA.root, "the quick brown fox");
        const { doc: docB, root: rootB } = clonePeer(peerA.doc);

        const N = 12;
        for (let i = 0; i < N; i++) {
          randomOp(genA, peerA.root);
          randomOp(genB, rootB);
        }
        syncBoth(peerA.doc, docB);

        // Strong Eventual Consistency: identical delivered op-set → identical projection.
        expect(toText(peerA.root)).to.equal(toText(rootB));
        expect(segments(peerA.root)).to.deep.equal(segments(rootB));
        // sanity: the projection is well-formed (no empty runs leaked, every run a string).
        for (const s of segments(peerA.root)) {
          expect(typeof s.text).to.equal("string");
          expect(s.text.length).to.be.greaterThan(0);
        }
      });
    }
  });
});
