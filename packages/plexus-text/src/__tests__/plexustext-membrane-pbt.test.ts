import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  addMark,
  deleteTextRange,
  insertTextAt,
  removeMark,
  segments,
  textDiff,
  toText,
  unformat,
} from "../marker.js";
import { isMarker, isTextAtom, Mark, Marker, PlexusText } from "../PlexusText.js";
import { initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * Layer B — pure membrane property tests (sequential, local).
 *
 * B1 segments is total (never throws)
 * B2 segText(segments) === toText
 * B3 deleteTextRange never removes Marker nodes
 * B4 addMark + removeMark balance (paired markers)
 * B5 projection deterministic (two reads agree)
 * B6 textDiff apply never leaves lone surrogates
 */

function empty(): PlexusText {
  return initTestPlexus(new PlexusText({})).root;
}

function segText(text: PlexusText): string {
  return segments(text)
    .map((s) => s.text)
    .join("");
}

function markerCount(text: PlexusText): number {
  return text.nodes.filter(isMarker).length;
}

function isBalanced(text: PlexusText): boolean {
  const opens = new Map<Mark, number>();
  for (const n of text.nodes) {
    if (!isMarker(n)) continue;
    const c = opens.get(n.mark) ?? 0;
    if (n.open) opens.set(n.mark, c + 1);
    else {
      if (c <= 0) return false; // close without open in order (orphans OK if we allow; B4 is sequential add/remove)
      opens.set(n.mark, c - 1);
    }
  }
  for (const c of opens.values()) if (c !== 0) return false;
  return true;
}

/** Markers that still have both ends present (paired). */
function paired(text: PlexusText): boolean {
  const open = new Set<Mark>();
  const close = new Set<Mark>();
  for (const n of text.nodes) {
    if (!isMarker(n)) continue;
    if (n.open) open.add(n.mark);
    else close.add(n.mark);
  }
  if (open.size !== close.size) return false;
  for (const m of open) if (!close.has(m)) return false;
  return true;
}

const sensible = fc.stringMatching(/^[a-zA-Z0-9 ]{0,20}$/);

type Op =
  | { kind: "insert"; offset: number; str: string }
  | { kind: "delete"; from: number; to: number }
  | { kind: "addMark"; from: number; to: number; type: string }
  | { kind: "unformat"; from: number; to: number; type: string }
  | { kind: "removeAllMarks" };

function applyOp(text: PlexusText, op: Op): void {
  const len = toText(text).length;
  switch (op.kind) {
    case "insert": {
      const at = len === 0 ? 0 : Math.abs(op.offset) % (len + 1);
      insertTextAt(text, at, op.str);
      break;
    }
    case "delete": {
      if (len === 0) return;
      const a = Math.abs(op.from) % (len + 1);
      const b = Math.abs(op.to) % (len + 1);
      deleteTextRange(text, Math.min(a, b), Math.max(a, b));
      break;
    }
    case "addMark": {
      if (len === 0) return;
      const a = Math.abs(op.from) % (len + 1);
      const b = Math.abs(op.to) % (len + 1);
      if (a === b) return;
      addMark(text, Math.min(a, b), Math.max(a, b), op.type, true);
      break;
    }
    case "unformat": {
      if (len === 0) return;
      const a = Math.abs(op.from) % (len + 1);
      const b = Math.abs(op.to) % (len + 1);
      unformat(text, Math.min(a, b), Math.max(a, b), op.type);
      break;
    }
    case "removeAllMarks": {
      // snapshot marks that still have markers in the sequence
      const seen = new Set<Mark>();
      for (const n of text.nodes) if (isMarker(n)) seen.add(n.mark);
      for (const m of seen) removeMark(text, m);
      break;
    }
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    offset: fc.nat(30),
    str: sensible,
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    from: fc.nat(30),
    to: fc.nat(30),
  }),
  fc.record({
    kind: fc.constant("addMark" as const),
    from: fc.nat(30),
    to: fc.nat(30),
    type: fc.constantFrom("bold", "italic", "code"),
  }),
  fc.record({
    kind: fc.constant("unformat" as const),
    from: fc.nat(30),
    to: fc.nat(30),
    type: fc.constantFrom("bold", "italic", "code"),
  }),
  fc.constant({ kind: "removeAllMarks" as const }),
);

describe("Layer B — membrane PBT", () => {
  it("B1+B2+B5: segments total, agrees with toText, deterministic (200 runs)", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 25 }), (ops) => {
        const text = empty();
        for (const op of ops) applyOp(text, op);
        // B1 total
        const a = segments(text);
        const b = segments(text);
        // B5 deterministic
        expect(a).to.deep.equal(b);
        // B2
        expect(segText(text)).to.equal(toText(text));
        // no empty runs
        for (const s of a) expect(s.text.length).to.be.greaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it("B3: deleteTextRange never removes Marker nodes", () => {
    fc.assert(
      fc.property(sensible, fc.array(opArb, { maxLength: 15 }), fc.nat(40), fc.nat(40), (seed, ops, from, to) => {
        const text = empty();
        if (seed) insertTextAt(text, 0, seed);
        for (const op of ops) applyOp(text, op);
        const before = markerCount(text);
        const len = toText(text).length;
        if (len === 0) return;
        const a = from % (len + 1);
        const b = to % (len + 1);
        deleteTextRange(text, Math.min(a, b), Math.max(a, b));
        expect(markerCount(text)).to.equal(before);
      }),
      { numRuns: 200 },
    );
  });

  it("B4: sequential addMark/removeMark keeps pairs balanced", () => {
    fc.assert(
      fc.property(sensible, fc.array(opArb, { maxLength: 20 }), (seed, ops) => {
        const text = empty();
        if (seed) insertTextAt(text, 0, seed);
        for (const op of ops) applyOp(text, op);
        // After any sequence that only uses our intent ops, every remaining marker
        // should be part of an open+close pair (intent ops never emit half-pairs).
        // Orphans can only arise from hand-placed markers, not from applyOp.
        expect(paired(text)).to.equal(true);
      }),
      { numRuns: 200 },
    );
  });

  it("B6: textDiff apply never leaves lone surrogates", () => {
    const emojiish = fc.constantFrom("a", "ab", "😀", "😀b", "a😎c", "🎉", "x🎉y");
    fc.assert(
      fc.property(emojiish, emojiish, (before, after) => {
        const text = empty();
        insertTextAt(text, 0, before);
        const d = textDiff(before, after);
        if (d === null) {
          expect(toText(text)).to.equal(after);
          return;
        }
        if (d.to > d.from) deleteTextRange(text, d.from, d.to);
        if (d.insert.length > 0) insertTextAt(text, d.from, d.insert);
        const result = toText(text);
        expect(result).to.equal(after);
        // no lone high or low surrogate
        for (let i = 0; i < result.length; i++) {
          const c = result.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff) {
            expect(i + 1 < result.length).to.equal(true);
            const d2 = result.charCodeAt(i + 1);
            expect(d2 >= 0xdc00 && d2 <= 0xdfff).to.equal(true);
            i++;
          } else {
            expect(c < 0xdc00 || c > 0xdfff).to.equal(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("hand-placed orphan close does not crash segments (totality under malformed)", () => {
    const text = empty();
    insertTextAt(text, 0, "abc");
    const m = new Mark({ type: "bold" });
    text.marks.add(m);
    text.nodes.splice(1, 0, new Marker({ open: false, mark: m })); // orphan End
    expect(() => segments(text)).to.not.throw();
    expect(segText(text)).to.equal(toText(text));
  });
});
