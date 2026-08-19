import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, segments, textDiff, textDiffs, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { initTestPlexus } from "./_helpers/test-plexus.js";

// Edge-case unit tests for the Peritext model (one Y.Text, markers as length-1 embeds).
// Where character offsets and Y.Text positions diverge (a marker embed is length 1 in
// Y.Text space but zero-width in character space), the off-by-one risk is highest — these
// tests hammer that seam. Each `it` runs the real code, observes, then asserts the
// observed (correct) behavior; genuine bugs are pinned with `it.fails` + a comment.

function emptyText() {
  return new PlexusText({});
}

// ── 1. Offset ↔ Y.Text-position (highest risk) ───────────────────────────────────

describe("offset ↔ Y.Text position (embeds are length-1 but zero-width chars)", () => {
  it("insertTextAt lands at the right CHARACTER with K embeds before the offset", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdefgh");
    // Lay down three marks BEFORE char offset 6 → 6 marker embeds precede offset 6 in Y space.
    addMark(root, 0, 1, "bold"); // open@0 close@1
    addMark(root, 1, 2, "italic"); // open@1 close@2
    addMark(root, 2, 3, "underline"); // open@2 close@3

    // Char offset 6 sits between "f"(idx5) and "g"(idx6); inserting there must land between
    // them in CHARACTER terms regardless of the 6 embeds threaded earlier in the sequence.
    insertTextAt(root, 6, "X");
    expect(toText(root)).to.equal("abcdefXgh");
  });

  it("deleteTextRange removes the right CHARACTERS past many embeds", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "0123456789");
    addMark(root, 0, 1, "a");
    addMark(root, 1, 2, "b");
    addMark(root, 2, 3, "c");
    // Delete chars [6,8) → should remove "67" leaving "01234589".
    deleteTextRange(root, 6, 8);
    expect(toText(root)).to.equal("01234589");
  });

  it("addMark boundaries are char-offsets: a mark after several embeds wraps the right chars", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdefgh");
    addMark(root, 0, 2, "bold"); // 2 embeds at the front
    // Now place a mark at char [6,8) — must wrap "gh", not be shifted by the leading embeds.
    addMark(root, 6, 8, "link", "u");
    expect(segments(root)).to.deep.equal([
      { text: "ab", marks: { bold: true } },
      { text: "cdef", marks: {} },
      { text: "gh", marks: { link: "u" } },
    ]);
  });

  it("insert at an offset equal to the end of a string run, just before a following embed", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcd");
    addMark(root, 2, 4, "bold"); // open@2, close@4 (close is at the very end)
    // Char offset 4 is end-of-doc; offsetToYPos returns the position before trailing close
    // marker? Observe: inserting "Z" at 4 appends Z. Where does Z sit relative to the close?
    insertTextAt(root, 4, "Z");
    expect(toText(root)).to.equal("abcdZ");
  });
});

// ── 2. addMark edges ──────────────────────────────────────────────────────────────

describe("addMark edges", () => {
  it("empty range (from == to) inserts a zero-width open/close pair, projecting no marked text", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "hello");
    addMark(root, 2, 2, "bold");
    expect(toText(root)).to.equal("hello");
    // No character sits between the open and close → no run carries the mark.
    expect(segments(root)).to.deep.equal([{ text: "hello", marks: {} }]);
  });

  it("adjacent spans (one ends where the next begins) stay distinct", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 3, "bold");
    addMark(root, 3, 6, "italic");
    expect(segments(root)).to.deep.equal([
      { text: "abc", marks: { bold: true } },
      { text: "def", marks: { italic: true } },
    ]);
  });

  it("a span at offset 0 marks from the very start", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 3, "bold");
    expect(segments(root)).to.deep.equal([
      { text: "abc", marks: { bold: true } },
      { text: "def", marks: {} },
    ]);
  });

  it("a span ending at the very end marks through the last char", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 3, 6, "bold");
    expect(segments(root)).to.deep.equal([
      { text: "abc", marks: {} },
      { text: "def", marks: { bold: true } },
    ]);
  });

  it("two identical-range marks of different types both apply", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 1, 4, "bold");
    addMark(root, 1, 4, "italic");
    expect(segments(root)).to.deep.equal([
      { text: "a", marks: {} },
      { text: "bcd", marks: { bold: true, italic: true } },
      { text: "ef", marks: {} },
    ]);
  });

  it("a mark over the whole doc marks everything", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 6, "bold");
    expect(segments(root)).to.deep.equal([{ text: "abcdef", marks: { bold: true } }]);
  });

  it("a mark whose [from,to) straddles an EXISTING mark's embeds wraps the right chars", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdefgh");
    addMark(root, 2, 5, "bold"); // lays embeds inside the doc at char 2 and 5
    // italic's [1,6) straddles bold's two embeds; close-first insertion must still land on
    // the right CHARACTERS (1 and 6) despite the bold embeds now threaded between them.
    addMark(root, 1, 6, "italic");
    expect(toText(root)).to.equal("abcdefgh");
    expect(segments(root)).to.deep.equal([
      { text: "a", marks: {} },
      { text: "b", marks: { italic: true } },
      { text: "cde", marks: { italic: true, bold: true } },
      { text: "f", marks: { italic: true } },
      { text: "gh", marks: {} },
    ]);
  });

  it("addMark with `to` past end clamps to the document end", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abc");
    addMark(root, 1, 99, "bold"); // offsetToYPos returns the end position for an over-large offset
    expect(toText(root)).to.equal("abc");
    expect(segments(root)).to.deep.equal([
      { text: "a", marks: {} },
      { text: "bc", marks: { bold: true } },
    ]);
  });
});

// ── 3. insertTextAt edges ───────────────────────────────────────────────────────

describe("insertTextAt edges", () => {
  it("into an empty doc (no Y.Text content yet)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "hello");
    expect(toText(root)).to.equal("hello");
    expect(segments(root)).to.deep.equal([{ text: "hello", marks: {} }]);
  });

  it("at start / mid / end of existing text", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "bd");
    insertTextAt(root, 0, "a"); // start → "abd"
    insertTextAt(root, 2, "c"); // mid → "abcd"
    insertTextAt(root, 4, "e"); // end → "abcde"
    expect(toText(root)).to.equal("abcde");
  });

  it("inserting at the START boundary of a mark INHERITS it (leading open embed pre-advances yPos)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "world");
    addMark(root, 0, 5, "bold"); // delta: [open, "world", close]
    // offsetToYPos(delta, 0): the open embed is the FIRST op → the string-run branch isn't
    // reached until "world", and by then yPos is already 1 (the embed advanced it). The
    // run satisfies chars(0)+5 >= 0 → returns yPos(1) + 0 = 1, i.e. INSIDE the span (after
    // the open). So X lands between the open marker and "w" → X inherits bold. This is the
    // start-boundary expand semantics: an offset-0 insert is absorbed by a span opening at 0.
    insertTextAt(root, 0, "X");
    expect(toText(root)).to.equal("Xworld");
    expect(segments(root)).to.deep.equal([{ text: "Xworld", marks: { bold: true } }]);
  });

  it("inserting INSIDE a mark inherits it", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "world");
    addMark(root, 0, 5, "bold");
    insertTextAt(root, 2, "X"); // inside [0,5)
    expect(toText(root)).to.equal("woXrld");
    expect(segments(root)).to.deep.equal([{ text: "woXrld", marks: { bold: true } }]);
  });

  it("inserting at the END boundary of a mark does NOT inherit it (close sits at the offset)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "world");
    addMark(root, 0, 5, "bold"); // close@5
    // offsetToYPos(...,5): the string run is the whole "world" (yPos 0..5 around the embeds);
    // char offset 5 === end of run → returns the position just after the run's last char,
    // which is BEFORE the close embed → inserted text falls inside the bold span. Observe.
    insertTextAt(root, 5, "X");
    expect(toText(root)).to.equal("worldX");
    // Pin the ACTUAL inherit-vs-not behavior at the end boundary.
    expect(segments(root)).to.deep.equal([{ text: "worldX", marks: { bold: true } }]);
  });

  it("inserting at the CLOSE boundary INHERITS the mark (close is inclusive / expand-right)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 3, "bold"); // delta: [open, "abc", close, "def"]
    // offsetToYPos(delta, 3): "abc" satisfies chars(0)+3 >= 3 (the >= is the key) → returns
    // yPos(0)+3 = 3, the position right AFTER "abc" but BEFORE the close embed. So X lands
    // inside the bold span: end-of-run inserts are inclusive of the closing mark.
    insertTextAt(root, 3, "X");
    expect(toText(root)).to.equal("abcXdef");
    expect(segments(root)).to.deep.equal([
      { text: "abcX", marks: { bold: true } },
      { text: "def", marks: {} },
    ]);
  });
});

// ── 4. deleteTextRange edges ────────────────────────────────────────────────────

describe("deleteTextRange edges", () => {
  it("a range fully inside a mark keeps the mark well-formed", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 6, "bold");
    deleteTextRange(root, 2, 4); // delete "cd", still inside [0,6)
    expect(toText(root)).to.equal("abef");
    expect(segments(root)).to.deep.equal([{ text: "abef", marks: { bold: true } }]);
  });

  it("deleting a range across the CLOSE collapses onto it — the close survives, span shrinks, no bleed", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdefgh");
    addMark(root, 2, 5, "bold"); // delta: ["ab", open, "cde", close, "fgh"]
    // Char [4,6) maps to Y [5,8): "e", the close embed, and "f". deleteTextRange PRESERVES
    // the close (markers are never destroyed) — only the TEXT collapses. Surviving text is
    // "ab" + "cd" + "gh" = "abcdgh"; "cd" still sits inside [open,close) → bold; "gh" is
    // after the surviving close → stays plain. The span SHRANK; it did not bleed to the end.
    deleteTextRange(root, 4, 6);
    const segs = segments(root);
    expect(toText(root)).to.equal("abcdgh");
    // Well-formed: no crash, every run has a valid marks object; formatting ends at the close.
    expect(segs.every((s) => typeof s.text === "string" && s.marks != null)).to.equal(true);
    expect(segs).to.deep.equal([
      { text: "ab", marks: {} },
      { text: "cd", marks: { bold: true } },
      { text: "gh", marks: {} },
    ]);
  });

  it("deleting a range across the OPEN collapses onto it — the open survives, surviving text keeps the mark", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdefgh");
    addMark(root, 3, 6, "bold"); // open@3 close@6 → "def" bold
    // Char [2,4) maps across the open embed: "c", the open, and "d". deleteTextRange PRESERVES
    // the open — only the TEXT collapses. Surviving "ab" (before open) + "ef" (inside the span,
    // before close) = "abefgh"; "ef" still sits inside [open,close) → bold; "gh" after the
    // close → plain. The "ef" that survived KEEPS its formatting — no char was stripped.
    deleteTextRange(root, 2, 4);
    const segs = segments(root);
    expect(toText(root)).to.equal("abefgh");
    expect(segs.every((s) => s.marks != null)).to.equal(true);
    expect(segs).to.deep.equal([
      { text: "ab", marks: {} },
      { text: "ef", marks: { bold: true } },
      { text: "gh", marks: {} },
    ]);
  });

  it("deleting an entire marked span collapses it to zero width — both markers are PRESERVED", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 2, 4, "bold"); // open@2 close@4 wrapping "cd"
    // Delete chars [2,4) — the full marked text "cd". deleteTextRange PRESERVES both markers
    // (they are never destroyed): only the TEXT collapses, leaving a ZERO-WIDTH span whose
    // open and close now sit adjacent. The Mark entity is still owned; no run carries it
    // because there is no character between the two embeds.
    deleteTextRange(root, 2, 4);
    expect(toText(root)).to.equal("abef");
    expect(segments(root)).to.deep.equal([{ text: "abef", marks: {} }]);
    // The markers were preserved, not removed — the Mark entity survives in the overlay.
    expect([...root.marks].length).to.equal(1);
  });

  it("deleting everything leaves an empty doc with no marks", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 1, 4, "bold");
    addMark(root, 0, 6, "italic");
    deleteTextRange(root, 0, 6);
    expect(toText(root)).to.equal("");
    expect(segments(root)).to.deep.equal([]);
  });

  it("an empty range (from == to) and an inverted range (from > to) are both no-ops", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abc");
    deleteTextRange(root, 2, 2); // empty — yTo === yFrom, guarded out
    expect(toText(root)).to.equal("abc");
    deleteTextRange(root, 3, 1); // inverted — yTo < yFrom, guarded out (no accidental delete)
    expect(toText(root)).to.equal("abc");
  });
});

// ── 5. toText / segments edges ──────────────────────────────────────────────────

describe("toText / segments edges", () => {
  it("empty doc projects to empty text and no segments", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    expect(toText(root)).to.equal("");
    expect(segments(root)).to.deep.equal([]);
  });

  it("a doc with only markers and no text has empty text and no runs", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    // addMark over an empty doc lays down only embeds, no characters.
    addMark(root, 0, 0, "bold");
    expect(toText(root)).to.equal("");
    expect(segments(root)).to.deep.equal([]);
  });

  it("value:false vs absent mark are distinct in the projection", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abcdef");
    addMark(root, 0, 3, "bold", false); // explicit false
    const segs = segments(root);
    // "abc" carries bold:false; "def" has no bold key at all.
    expect(segs[0]).to.deep.equal({ text: "abc", marks: { bold: false } });
    expect(segs[1]).to.deep.equal({ text: "def", marks: {} });
    expect("bold" in segs[0]!.marks).to.equal(true);
    expect("bold" in segs[1]!.marks).to.equal(false);
  });

  it("toText ignores markers entirely (markers are zero-width)", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "abc");
    addMark(root, 0, 3, "bold");
    addMark(root, 1, 2, "italic");
    expect(toText(root)).to.equal("abc");
  });
});

// ── 6. textDiff (single-replace diff) ───────────────────────────────────────────

describe("textDiff", () => {
  it("returns null for identical strings", () => {
    expect(textDiff("hello", "hello")).to.equal(null);
  });

  it("detects a pure insertion in the middle", () => {
    expect(textDiff("hello world", "hello big world")).to.deep.equal({ from: 6, to: 6, insert: "big " });
  });

  it("detects a pure deletion", () => {
    expect(textDiff("hello big world", "hello world")).to.deep.equal({ from: 6, to: 10, insert: "" });
  });

  it("detects a replacement", () => {
    expect(textDiff("hello world", "hello there")).to.deep.equal({ from: 6, to: 11, insert: "there" });
  });

  it("detects an append (insert at end)", () => {
    expect(textDiff("abc", "abcdef")).to.deep.equal({ from: 3, to: 3, insert: "def" });
  });

  it("delete-all and insert-into-empty", () => {
    expect(textDiff("abc", "")).to.deep.equal({ from: 0, to: 3, insert: "" });
    expect(textDiff("", "abc")).to.deep.equal({ from: 0, to: 0, insert: "abc" });
  });

  it("repeated chars resolve prefix-greedily (append at the run's end, not the start)", () => {
    expect(textDiff("aaa", "aaaa")).to.deep.equal({ from: 3, to: 3, insert: "a" });
    expect(textDiff("aaaa", "aaa")).to.deep.equal({ from: 3, to: 4, insert: "" });
  });

  it("ambiguous repeat 'abcabc' -> 'abc' collapses to a single trailing deletion", () => {
    expect(textDiff("abcabc", "abc")).to.deep.equal({ from: 3, to: 6, insert: "" });
  });

  it("a textDiff applied via insertTextAt/deleteTextRange reproduces the after-string", () => {
    const { root } = initTestPlexus<PlexusText>(emptyText());
    insertTextAt(root, 0, "hello world");
    addMark(root, 0, 5, "bold");
    const d = textDiff(toText(root), "hello there");
    expect(d).to.not.equal(null);
    if (d) {
      if (d.to > d.from) deleteTextRange(root, d.from, d.to);
      if (d.insert) insertTextAt(root, d.from, d.insert);
    }
    expect(toText(root)).to.equal("hello there");
  });
});

// ── 6b. textDiffs (multi-hunk B7 / N3) ───────────────────────────────────────────

/** Apply TextReplace[] (before-coords) right-to-left so positions stay valid. */
function applyHunks(s: string, hunks: { from: number; to: number; insert: string }[]): string {
  let out = s;
  for (const h of [...hunks].reverse()) {
    out = out.slice(0, h.from) + h.insert + out.slice(h.to);
  }
  return out;
}

describe("textDiffs", () => {
  it("returns [] for identical strings", () => {
    expect(textDiffs("hello", "hello")).to.deep.equal([]);
  });

  it("single insert/delete/replace is one hunk equivalent to textDiff", () => {
    const cases: Array<[string, string]> = [
      ["hello world", "hello big world"],
      ["hello big world", "hello world"],
      ["hello world", "hello there"],
      ["abc", "abcdef"],
      ["abc", ""],
      ["", "abc"],
      ["aaa", "aaaa"],
      ["aaaa", "aaa"],
    ];
    for (const [before, after] of cases) {
      const single = textDiff(before, after);
      const multi = textDiffs(before, after);
      if (single === null) {
        expect(multi).to.deep.equal([]);
      } else {
        expect(multi).to.deep.equal([single]);
      }
      expect(applyHunks(before, multi)).to.equal(after);
    }
  });

  it("two-end inserts on short string → 2 hunks", () => {
    const before = "hello world";
    const after = "Xhello worldY";
    const hunks = textDiffs(before, after);
    expect(hunks).to.have.length(2);
    expect(hunks[0]).to.deep.equal({ from: 0, to: 0, insert: "X" });
    expect(hunks[1]).to.deep.equal({ from: 11, to: 11, insert: "Y" });
    expect(applyHunks(before, hunks)).to.equal(after);
  });

  it("xxxx → AxxxxZ → 2 insert hunks of length 1", () => {
    const before = "xxxx";
    const after = "AxxxxZ";
    const hunks = textDiffs(before, after);
    expect(hunks).to.have.length(2);
    expect(hunks[0]).to.deep.equal({ from: 0, to: 0, insert: "A" });
    expect(hunks[1]).to.deep.equal({ from: 4, to: 4, insert: "Z" });
    expect(applyHunks(before, hunks)).to.equal(after);
  });

  it("S5-style N=4000 plain + insert A at 0 + Z at end → 2 hunks, small spans", () => {
    const N = 4000;
    const before = "x".repeat(N);
    const after = "A" + before + "Z";
    const hunks = textDiffs(before, after);
    expect(hunks).to.have.length(2);
    expect(hunks[0]).to.deep.equal({ from: 0, to: 0, insert: "A" });
    expect(hunks[1]).to.deep.equal({ from: N, to: N, insert: "Z" });
    const replaceCharsMax = Math.max(...hunks.map((h) => h.to - h.from + h.insert.length));
    expect(replaceCharsMax).to.be.lessThanOrEqual(2);
    expect(applyHunks(before, hunks)).to.equal(after);
  });

  it("two distant mid replaces split on shared interior", () => {
    const before = "aaaaBBBBccccDDDDeeee";
    const after = "aaaaXXXXccccYYYYeeee";
    const hunks = textDiffs(before, after);
    expect(hunks.length).to.be.greaterThanOrEqual(2);
    expect(applyHunks(before, hunks)).to.equal(after);
    // Each hunk should be local (not span the whole mid).
    for (const h of hunks) {
      expect(h.to - h.from + h.insert.length).to.be.lessThan(before.length / 2);
    }
  });

  it("two distant deletes → 2 delete hunks", () => {
    const before = "AxxxxZ";
    const after = "xxxx";
    const hunks = textDiffs(before, after);
    expect(hunks).to.have.length(2);
    expect(hunks[0]).to.deep.equal({ from: 0, to: 1, insert: "" });
    expect(hunks[1]).to.deep.equal({ from: 5, to: 6, insert: "" });
    expect(applyHunks(before, hunks)).to.equal(after);
  });

  it("totally different middle → one hunk (fallback OK)", () => {
    const before = "pre_ABCDEF_suf";
    const after = "pre_xyzxyz_suf";
    const hunks = textDiffs(before, after);
    expect(hunks).to.have.length(1);
    expect(hunks[0]).to.deep.equal({ from: 4, to: 10, insert: "xyzxyz" });
    expect(applyHunks(before, hunks)).to.equal(after);
  });

  it("surrogate-safe: does not split emoji pairs", () => {
    const before = "a😀b😎c";
    const after = "Xa😀b😎cY";
    const hunks = textDiffs(before, after);
    expect(hunks).to.have.length(2);
    expect(hunks[0]!.insert).to.equal("X");
    expect(hunks[1]!.insert).to.equal("Y");
    expect(applyHunks(before, hunks)).to.equal(after);
    // Single-region emoji replace still one hunk, no lone surrogates in insert.
    const d = textDiffs("hi😀", "hi😎");
    expect(d).to.have.length(1);
    expect(d[0]!.insert).to.equal("😎");
    expect(applyHunks("hi😀", d)).to.equal("hi😎");
  });
});
