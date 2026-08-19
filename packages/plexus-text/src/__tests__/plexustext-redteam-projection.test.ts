import { describe, expect, it } from "vitest";

import { addMark, deleteTextRange, insertTextAt, type Segment, segments, toText } from "../marker.js";
import { Mark, Marker, PlexusText } from "../PlexusText.js";
import { initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * RED-TEAM the stream→tree projection `segments()` over the entity sequence.
 *
 * The CLAIM under attack: segments() is a TOTAL, CORRECT projection — every character gets
 * exactly the marks of the spans covering it, never a mark it isn't under, never crashing,
 * for ANY marker arrangement (including orphan Start/End nodes placed by hand).
 */
function segText(segs: Segment[]): string {
  return segs.map((s) => s.text).join("");
}

function emptyText() {
  return new PlexusText({});
}

/** Place a void Marker at list index `listIndex` pointing at `mark`. */
function placeMarker(text: PlexusText, listIndex: number, mark: Mark, open: boolean): void {
  text.nodes.splice(listIndex, 0, new Marker({ open, mark }));
}

/** Create + own a real Mark and return it (for hand-placed half-pairs / orphans). */
function makeMark(text: PlexusText, type: string, value: string | boolean | null = true): Mark {
  const mark = new Mark({ type, value });
  text.marks.add(mark);
  return mark;
}

describe("RED-TEAM: segments() stream→tree projection", () => {
  // Foreign Y.Text embeds are gone with the entity model — N/A. Orphan markers remain.

  it("empty doc projects to no runs", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    expect(segments(root)).to.deep.equal([]);
    expect(toText(root)).to.equal("");
  });

  // ════════════════════════════════════════════════════════════════════════════════
  //  ATTACKS THAT DID NOT BREAK (green) — the projection is correct on these.
  // ════════════════════════════════════════════════════════════════════════════════

  // ── Deep nesting: innermost wins, each close re-exposes the right outer value ─────
  it("survives 10-deep same-type nesting — innermost wins, each close re-exposes the right outer", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    const N = 10;
    const body = "abcdefghijklmnopqrstuvwxyzABCD"; // 30 chars
    const len = body.length;
    insertTextAt(root, 0, body);
    // Concentric "link" spans v0..v9, each window [i, len-i). They strictly nest:
    // v0 covers all, v9 the innermost band. Innermost-active = highest i covering a char.
    for (let i = 0; i < N; i++) addMark(root, i, len - i, "link", `v${i}`);

    const segs = segments(root);
    // Projection is total — exact string content preserved, no invented/dropped chars.
    expect(segText(segs)).to.equal(body);

    // Independent ground truth: for each character, the innermost covering span is v_d where
    // d = max i such that i <= ch < len-i. Read the projected value at every char and compare.
    const innermostExpected = (ch: number): string => {
      let d = 0;
      for (let i = 0; i < N; i++) if (i <= ch && ch < len - i) d = i;
      return `v${d}`;
    };
    let acc = 0;
    for (const r of segs) {
      for (let k = 0; k < r.text.length; k++) {
        // every char in this run reads the run's single link value; it must be the innermost.
        expect(r.marks.link).to.equal(innermostExpected(acc + k));
      }
      acc += r.text.length;
    }
    // Spot-check the re-exposure on the way OUT: the last band (char len-1) is back to v0.
    expect(segs.at(-1)?.marks.link).to.equal("v0");
  });

  // ── Braid of crossings: many same-type spans all crossing, hand-checked ──────────
  it("survives a braid of crossing same-type spans — each run's value is hand-verified", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "0123456789");
    // Three link spans that all CROSS each other (interleaved open/close), distinct values:
    //   A = link "A" over [0,6)
    //   B = link "B" over [3,9)
    //   C = link "C" over [1,4)
    // Pairing is by span id (addMark), so crossings resolve by intent, not nearest-open.
    addMark(root, 0, 6, "link", "A");
    addMark(root, 3, 9, "link", "B");
    addMark(root, 1, 4, "link", "C");

    const segs = segments(root);
    expect(segText(segs)).to.equal("0123456789");
    // Hand-computed innermost-active (Map insertion order = open order A,B,C; last-opened wins):
    //  char 0: A            → "A"
    //  char 1: A,C          → C (opened after A)
    //  char 2: A,C          → C
    //  char 3: A,C,B        → B (B opens at 3, after C) — wait: order of opens at boundary 3:
    //          C closes at 4, B opens at 3. At char 3 active = {A, C, B} insertion A,C,B → B wins
    //  char 4..5: A,B       → B
    //  char 6..8: B         → B
    //  char 9: none
    // We assert the per-character innermost value directly.
    const valueAt = (ch: number): string | undefined => {
      let acc = 0;
      for (const r of segs) {
        if (ch >= acc && ch < acc + r.text.length) return r.marks.link as string | undefined;
        acc += r.text.length;
      }
      return undefined;
    };
    expect(valueAt(0)).to.equal("A");
    expect(valueAt(1)).to.equal("C");
    expect(valueAt(2)).to.equal("C");
    expect(valueAt(3)).to.equal("B");
    expect(valueAt(4)).to.equal("B");
    expect(valueAt(5)).to.equal("B");
    expect(valueAt(6)).to.equal("B");
    expect(valueAt(8)).to.equal("B");
    expect(valueAt(9)).to.equal(undefined);
  });

  // ── Delete across a close — the span collapses ONTO its preserved close ───────────
  it("delete across a mark's close preserves it — span keeps its right edge, no orphan", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcde");
    addMark(root, 1, 3, "bold");
    // Delete [3,5) ("de"): the close sits at offset 3; deleteTextRange COLLAPSES onto it (the
    // marker is preserved, not eaten), so the bold span keeps its right edge — no orphan, no bleed.
    deleteTextRange(root, 3, 5);
    const segs = segments(root);
    expect(segText(segs)).to.equal("abc");
    // "bc" stays bold (open…close intact), "a" plain. The mark does NOT run to end.
    expect(segs).to.deep.equal([
      { text: "a", marks: {} },
      { text: "bc", marks: { bold: true } },
    ]);
  });

  // ── Orphan CLOSE (no open) — `active.delete` of a never-opened mark is a harmless no-op ─
  it("survives an orphan close (no matching open) — no-op delete, no mark, no crash", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcde");
    const mark = makeMark(root, "bold");
    placeMarker(root, 2, mark, false); // lone End after "ab"
    expect(segments(root)).to.deep.equal([{ text: "abcde", marks: {} }]);
  });

  // ── Multiple orphans of the same type interleaved ────────────────────────────────
  it("survives multiple interleaved orphans of the same type", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    // nodes: a b c d e f  — place orphan End after a, Start after ab, orphan End at end
    const o1 = makeMark(root, "bold");
    const real = makeMark(root, "bold");
    const o2 = makeMark(root, "bold");
    placeMarker(root, 1, o1, false); // after "a"
    placeMarker(root, 3, real, true); // after "ab" (index shifted by prior marker)
    placeMarker(root, root.nodes.length, o2, false); // trailing orphan End
    const segs = segments(root);
    expect(segText(segs)).to.equal("abcdef");
    expect(segs.every((s) => typeof s.text === "string")).to.equal(true);
    const boldText = segs
      .filter((s) => s.marks.bold === true)
      .map((s) => s.text)
      .join("");
    // real open after "ab", no close → bolds "cdef"
    expect(boldText).to.equal("cdef");
  });

  // ── Zero-width span (addMark from==to) — invisible, leaks no run ──────────────────
  it("survives a zero-width span (from==to) — no empty run, no mark", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcde");
    addMark(root, 2, 2, "bold"); // open and close land adjacent, no char between them
    expect(segments(root)).to.deep.equal([{ text: "abcde", marks: {} }]);
    expect(segments(root).every((s) => s.text.length > 0)).to.equal(true);
  });

  // ── value variants: false / null / "" are DISTINCT from absent and preserved ─────
  it("preserves falsy mark values (false, null, '') as present marks, distinct from absent", () => {
    for (const v of [false, null, ""] as const) {
      const { root } = initTestPlexus<PlexusText>(emptyText());
      insertTextAt(root, 0, "abcde");
      addMark(root, 1, 3, "k", v);
      const segs = segments(root);
      const mid = segs.find((s) => s.text === "bc");
      // the mark is PRESENT with the falsy value — not collapsed to "absent".
      expect(mid?.marks).to.deep.equal({ k: v });
      expect("k" in (mid?.marks ?? {})).to.equal(true);
      // neighbours are genuinely absent (no "k" key), so sameMarks correctly splits the run.
      expect("k" in (segs.find((s) => s.text === "a")?.marks ?? {})).to.equal(false);
    }
  });

  // ── Adjacent identical-value spans merge into ONE run (no seam) ───────────────────
  it("merges adjacent identical-value spans — no seam between [0,3) and [3,6) bold", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 3, "bold");
    addMark(root, 3, 6, "bold");
    // sameMarks coalesces — one uniform bold run, no empty/odd seam at the join.
    expect(segments(root)).to.deep.equal([{ text: "abcdef", marks: { bold: true } }]);
  });

  // Foreign embeds no longer exist in the entity model — covered by orphan-marker cases above.
});
