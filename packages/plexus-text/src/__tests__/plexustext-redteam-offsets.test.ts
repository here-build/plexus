import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, segments, toText } from "../marker.js";
import { Mark, Marker, PlexusText } from "../PlexusText.js";
import { initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * RED-TEAM: break the character-offset ↔ Y.Text-position mapping in marker.ts.
 *
 * CLAIM under attack: "insert/delete at character offset N always affects exactly the
 * intended characters, for any arrangement of preceding/surrounding marker embeds and any
 * text content."
 *
 * `offsetToYPos` bridges two coordinate systems:
 *   - CHARACTER offsets (what `toText`/editors speak): count only string runs.
 *   - Y.Text positions: count each marker embed as length-1.
 *
 * The mapping uses `op.insert.length` for run lengths. In JS that is the UTF-16 CODE-UNIT
 * count, NOT the Unicode-scalar count. An emoji like "😀" is one scalar but length 2.
 * Y.Text itself is also code-unit indexed, so the mapping is internally consistent in
 * code-unit space — the danger is at the CONTRACT boundary (the doc/JSDoc say "character").
 */

function emptyText() {
  return new PlexusText({});
}

function fresh(seed = ""): PlexusText {
  const { root } = initTestPlexus<PlexusText>(emptyText());
  if (seed) insertTextAt(root, 0, seed);
  return root;
}

/**
 * True iff the string carries evidence of a split surrogate pair.
 *
 * yjs (13.6.30) does NOT leave raw lone surrogates after a mid-surrogate edit — it
 * substitutes U+FFFD (the replacement character) for each broken half. So a shattered emoji
 * surfaces as one-or-more U+FFFD, not as a 0xD800..0xDFFF code unit. We detect BOTH so the
 * check is robust regardless of yjs's normalization choice.
 */
function hasSurrogateCorruption(s: string): boolean {
  if (s.includes("�")) return true; // yjs replaced a broken surrogate half
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true; // lone high surrogate
      i++; // valid pair, skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

describe("RED-TEAM: offset↔Y.Text mapping", () => {
  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 1 — surrogate pairs / emoji. The headline target.
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 1: surrogate pairs (emoji)", () => {
    // First, pin the GROUND of the attack: Y.Text is code-unit indexed and a mid-surrogate
    // insert shatters the emoji (yjs substitutes U+FFFD for each orphaned half). This is the
    // mechanism every scalar-offset break below rides on.
    it("baseline: atomsFromString keeps emoji as one atom (no mid-surrogate split)", () => {
      const t = fresh("😀ab");
      // 😀 is one atom of length 2; insertTextAt at code-unit 1 would need to split —
      // our atoms store the pair whole, so scalar-misuse is a caller contract issue.
      expect(toText(t).length).to.equal(4); // code units
      expect([...toText(t)].length).to.equal(3); // scalars
      expect(hasSurrogateCorruption(toText(t))).to.equal(false);
    });

    // BOUNDARY MARKER (stays it.fails): the contract is now documented as CODE-UNIT (UTF-16)
    // offsets — see the marker.ts module JSDoc, "Offsets are CODE-UNIT (UTF-16) offsets … the
    // bindings speak code units, so they don't [land mid-surrogate]." This test feeds SCALAR
    // offsets ([...str].length / Array.from cursors), which is the caller-side misuse the
    // contract warns against: offset 1 means "after the emoji" only in scalar space; the
    // function correctly reads code-unit 1 → mid-surrogate. It documents the boundary for a
    // caller that wrongly passes scalar offsets, not a defect in the code-unit binding path.
    it.fails(
      "RED-TEAM FINDING (scalar-offset misuse): insert at scalar-offset 1 lands MID-surrogate and shatters it",
      () => {
        const t = fresh("😀ab");
        // Caller intent: insert "X" right after the emoji → "😀Xab".
        // Scalar offset of that gap = 1 (😀 is scalar #0, the gap after it is offset 1).
        insertTextAt(t, 1, "X");
        // EXPECTED (character contract): "😀Xab", no broken code points.
        // ACTUAL: offsetToYPos treats 1 as a code-unit index → inserts between the surrogate
        // halves → "<hi>X<lo>ab" with two lone surrogates.
        expect(hasSurrogateCorruption(toText(t))).to.equal(false);
        expect(toText(t)).to.equal("😀Xab");
      },
    );

    // BOUNDARY MARKER (stays it.fails): scalar-offset misuse. With the documented CODE-UNIT
    // contract, this range would be expressed in code units; passing scalar offsets cuts the
    // emoji. Marks the boundary for a caller wrongly speaking scalars.
    it.fails(
      "RED-TEAM FINDING (scalar-offset misuse): delete of scalar-range [1,2) cuts the emoji in half",
      () => {
        const t = fresh("😀ab"); // scalars: 😀(0) a(1) b(2)
        // Caller intent: delete the "a" → "😀b".
        deleteTextRange(t, 1, 2);
        expect(hasSurrogateCorruption(toText(t))).to.equal(false);
        expect(toText(t)).to.equal("😀b");
      },
    );

    // BOUNDARY MARKER (stays it.fails): scalar-offset misuse. addMark's range is CODE-UNIT
    // per the documented contract; a scalar range splits the surrogate via the embed. Marks
    // the boundary for a caller wrongly speaking scalars.
    it.fails(
      "RED-TEAM FINDING (scalar-offset misuse): addMark over scalar-range [1,2) splits the surrogate via the embed",
      () => {
        // "a😀b" scalars: a(0) 😀(1) b(2). Bold just the emoji → range [1,2).
        const t = fresh("a😀b");
        addMark(t, 1, 2, "bold");
        // The close embed should sit AFTER the whole emoji and the open BEFORE it; with
        // code-unit math the close lands between the surrogate halves.
        expect(hasSurrogateCorruption(toText(t))).to.equal(false);
        const segs = segments(t);
        // The bolded run should be exactly the emoji, intact.
        const bolded = segs.find((s) => s.marks.bold === true);
        expect(bolded?.text).to.equal("😀");
      },
    );

    // The DEFENSIVE companion: in CODE-UNIT space the mapping is self-consistent. If a caller
    // already speaks code units (CodeMirror, ProseMirror positions), no split occurs. This is
    // the strongest attack that FAILS — it documents the function is safe IFF the contract is
    // code-units, not scalars.
    it("SURVIVES: with code-unit offsets, inserting after an emoji is clean", () => {
      const t = fresh("😀ab"); // code units: 😀 = [0,2), a=2, b=3
      insertTextAt(t, 2, "X"); // code-unit offset 2 = right after the full emoji
      expect(hasSurrogateCorruption(toText(t))).to.equal(false);
      expect(toText(t)).to.equal("😀Xab");
    });

    // ZWJ family emoji: "👨‍👧" = man + ZWJ + girl = 5 code units, but ONE grapheme / 3 scalars.
    // BOUNDARY MARKER (stays it.fails): scalar-offset misuse against the documented CODE-UNIT
    // contract. Marks the boundary for a caller wrongly passing a scalar offset.
    it.fails(
      "RED-TEAM FINDING (scalar-offset misuse): ZWJ sequence — scalar-offset insert lands inside the cluster",
      () => {
        const family = "👨‍👧"; // 5 code units, 3 scalars, 1 grapheme
        const t = fresh(family + "x");
        // Scalar offset 3 = right after the whole ZWJ family (scalars: 👨,ZWJ,👧 → gap at 3).
        insertTextAt(t, 3, "!");
        expect(hasSurrogateCorruption(toText(t))).to.equal(false);
        expect(toText(t)).to.equal(family + "!x");
      },
    );

    // Combining marks are NOT a surrogate problem (each is a single code unit), so they survive
    // even though they are not the same as a "perceived character". Documents the boundary.
    it("SURVIVES: combining accent (single code unit each) — offsets stay aligned", () => {
      const t = fresh("éx"); // "é" as e + combining-acute, then x. 3 code units, 3 "offsets"
      insertTextAt(t, 2, "Z"); // after the combining mark
      expect(toText(t)).to.equal("éZx");
      expect(hasSurrogateCorruption(toText(t))).to.equal(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 2 — many embeds before the offset.
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 2: many embeds before the offset", () => {
    it("SURVIVES: 20 nested marks then insert lands on the exact character", () => {
      const t = fresh("abcdefghij");
      // 20 marks all opening at 0 and closing at 10 → 40 embeds total, all before/around offset 5.
      for (let i = 0; i < 20; i++) addMark(t, 0, 10, `m${i}`);
      // Insert at character offset 5 → between "e" and "f".
      insertTextAt(t, 5, "|");
      expect(toText(t)).to.equal("abcde|fghij");
    });

    it("SURVIVES: insert after a run preceded by many close-embeds", () => {
      const t = fresh("abcdef");
      // mark [0,3) ten times → 10 opens at 0, 10 closes at 3. Offset 3 sits right after 10 closes.
      for (let i = 0; i < 10; i++) addMark(t, 0, 3, `k${i}`);
      insertTextAt(t, 3, "X"); // between "c" and "d", past all 10 close-embeds
      expect(toText(t)).to.equal("abcXdef");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 3 — offset exactly at an embed position (the >= boundary rule).
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 3: offset exactly at an embed boundary", () => {
    // "ab" <marker> "cd": char offset 2 is the gap between "b" and "c". The `>=` makes the
    // FIRST run ("ab", since 0+2 >= 2) win → yPos lands BEFORE the marker. So an insert at the
    // boundary goes before the embed. Documents the chosen (consistent) rule.
    it("insert at a run/embed boundary lands BEFORE the embed (consistent rule)", () => {
      const t = fresh("abcd");
      addMark(t, 2, 2, "x"); // zero-width mark: open AND close both at offset 2 (between b and c)
      // toText is unaffected by the embeds.
      expect(toText(t)).to.equal("abcd");
      insertTextAt(t, 2, "|");
      expect(toText(t)).to.equal("ab|cd");
    });

    // FIXED: a single-character DELETE whose START coincides with a span's open-embed.
    // "ab"<open@2>"cd"<close@4> — bold covers "cd". Deleting char [2,3) (just "c"). The
    // corrected deleteTextRange PRESERVES the open embed (markers are never destroyed) and
    // removes only the TEXT "c". The span stays well-formed: the UNTOUCHED "d" is still inside
    // [open,close) → it KEEPS its bold. Deleting one char no longer strips an adjacent char's
    // formatting (the old orphan-bleed bug is gone).
    it("deleting a char at a span's open-boundary preserves the mark on the NEXT (undeleted) char", () => {
      const t = fresh("abcd");
      addMark(t, 2, 4, "bold"); // open at offset 2 (before c), close at offset 4 (after d)
      expect(segments(t).find((s) => s.marks.bold)?.text).to.equal("cd"); // "cd" bold
      deleteTextRange(t, 2, 3); // delete just "c"
      expect(toText(t)).to.equal("abd"); // text is right …
      // … and "d" was never touched, so it KEEPS its bold.
      const dRun = segments(t).find((s) => s.text.includes("d"));
      expect(dRun?.marks.bold).to.equal(true);
      expect(segments(t)).to.deep.equal([
        { text: "ab", marks: {} },
        { text: "d", marks: { bold: true } },
      ]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 4 — delete spanning multiple embeds (orphan markers).
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 4: delete spanning multiple embeds", () => {
    it("delete across two marked words removes the right chars and does not corrupt projection", () => {
      const t = fresh("foo bar baz");
      addMark(t, 0, 3, "bold"); // foo
      addMark(t, 8, 11, "italic"); // baz
      // delete "o bar b" → chars [2, 9). spans the close-of-bold (at 3) and open-of-italic (at 8).
      deleteTextRange(t, 2, 9);
      expect(toText(t)).to.equal("foaz");
      // projection must stay well-formed (no throw, every run a string).
      for (const s of segments(t)) expect(typeof s.text).to.equal("string");
    });

    it("FIXED: deleting across a span's CLOSE preserves the close → the mark does NOT bleed past it", () => {
      // The old bug: deleting the close embed orphaned the open and the mark bled to end-of-doc.
      // The corrected deleteTextRange PRESERVES the close, so formatting stays bounded by it.
      // Delete a range that spans the close BUT leaves text after it, so "no bleed" is testable.
      const t = fresh("abcdefgh");
      addMark(t, 2, 5, "bold"); // bold "cde": open@2, close@5
      // Delete [4, 6) — covers "e", the close@5 embed, and "f". The close survives; only TEXT
      // collapses. Surviving "abcd" + "gh"; "cd" is inside [open,close) → bold, "gh" is AFTER
      // the preserved close → plain. The mark is bounded by the close, it does not bleed.
      deleteTextRange(t, 4, 6);
      expect(toText(t)).to.equal("abcdgh");
      const segs = segments(t);
      expect(segs).to.deep.equal([
        { text: "ab", marks: {} },
        { text: "cd", marks: { bold: true } },
        { text: "gh", marks: {} }, // text after the surviving close is NOT bold — no bleed
      ]);
      // And appending after the close stays plain too (the close bounds the span).
      insertTextAt(t, toText(t).length, "ZZ");
      const z = segments(t).find((s) => s.text.includes("ZZ"));
      expect(z?.marks.bold).to.not.equal(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 5 — boundary conditions: 0, length, past-length, inverted, equal, negative.
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 5: boundary conditions", () => {
    it("SURVIVES: insert at offset 0 and at offset == length", () => {
      const t = fresh("abc");
      insertTextAt(t, 0, "<");
      insertTextAt(t, toText(t).length, ">");
      expect(toText(t)).to.equal("<abc>");
    });

    it("SURVIVES: insert at offset > length clamps to end (no crash, no gap)", () => {
      const t = fresh("abc");
      insertTextAt(t, 999, "Z");
      expect(toText(t)).to.equal("abcZ");
    });

    it("deleteTextRange with from == to is a no-op", () => {
      const t = fresh("abc");
      deleteTextRange(t, 1, 1);
      expect(toText(t)).to.equal("abc");
    });

    // INVERTED range from > to. The guard is `if (yTo > yFrom)`, so an inverted range is a
    // silent no-op rather than a crash/corruption. Document it.
    it("inverted range (from > to) is a silent no-op, not corruption", () => {
      const t = fresh("abcdef");
      deleteTextRange(t, 4, 1);
      expect(toText(t)).to.equal("abcdef");
    });

    // NEGATIVE insert offset: offsetToYPos returns offset (=-1) for the first run, Y.Text clamps
    // a negative position to 0, so the insert lands at the START. Silent (no validation), but
    // non-destructive — the original chars survive in order. Documented as a survivor.
    it("SURVIVES (silently clamps): negative insert offset lands at start, no char loss", () => {
      const t = fresh("abc");
      insertTextAt(t, -1, "Z"); // offsetToYPos→-1, Y.Text clamps to 0
      expect(toText(t)).to.equal("Zabc"); // clamped to start; "abc" intact
    });

    // NEGATIVE delete-from (FIXED): deleteTextRange now CLAMPS the low end. Previously a
    // negative `from` inflated the delete length — offsetToYPos(-2) = -2, delete(-2, 2-(-2)=4)
    // removed FOUR chars ("abcd") while Y.Text only clamped the start. The fix guards
    // `if (to<=from||to<=0) return;` and maps `offsetToYPos(delta, Math.max(0,from))`, so the
    // effective range is [0,2) — exactly two chars removed, never an over-delete.
    it("FIXED: negative delete-from clamps — delete(-2,2) removes exactly two chars", () => {
      const t = fresh("abcdef");
      deleteTextRange(t, -2, 2); // intent: affect at most chars [0,2)
      // Clamped to [0,2): removes "ab", leaves "cdef" — never eats into "cd".
      expect(toText(t)).to.equal("cdef");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 6 — interleaved marks and text: insert at every offset 0..N.
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 6: interleaved marks, insert at every offset", () => {
    it("SURVIVES: a<open>b<close>c — insert at each offset 0..3 lands on the exact char", () => {
      // Build the interleaved structure: text "abc" with bold over just "b" ([1,2)).
      // Then for each offset, on a FRESH copy, insert a sentinel and check the plain text.
      const expectations: Array<[number, string]> = [
        [0, "Xabc"],
        [1, "aXbc"],
        [2, "abXc"],
        [3, "abcX"],
      ];
      for (const [off, want] of expectations) {
        const t = fresh("abc");
        addMark(t, 1, 2, "bold"); // open@1, close@2 — embeds straddle "b"
        insertTextAt(t, off, "X");
        expect(toText(t), `insert at offset ${off}`).to.equal(want);
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 7 — doc that is all-markers / textless, then map offset 0.
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 7: textless-but-embed-bearing document", () => {
    it("SURVIVES: delete all text leaving only markers, then insert at offset 0", () => {
      const t = fresh("abc");
      addMark(t, 0, 3, "bold"); // open@0, close@3
      deleteTextRange(t, 0, 3); // remove "abc"; markers may or may not survive
      // Now insert at character offset 0 — must land cleanly and produce exactly "Z".
      insertTextAt(t, 0, "Z");
      expect(toText(t)).to.equal("Z");
      for (const s of segments(t)) expect(typeof s.text).to.equal("string");
    });

    it("SURVIVES: insert into a doc that is ONLY a leading open-marker", () => {
      const t = fresh("");
      const m = new Mark({ type: "bold" });
      t.marks.add(m);
      t.nodes.splice(0, 0, new Marker({ open: true, mark: m }));
      insertTextAt(t, 0, "hi");
      expect(toText(t)).to.equal("hi");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // VECTOR 8 — round-trip / fuzz: random unicode + ops, toText must never carry garbage.
  // ════════════════════════════════════════════════════════════════════════════════
  describe("Vector 8: emoji fuzz round-trip", () => {
    // BOUNDARY MARKER (stays it.fails): scalar-offset misuse. The fuzz drives SCALAR offsets
    // (Array.from) against the documented CODE-UNIT contract, so an emoji eventually splits.
    // The code-unit binding path (CodeMirror/Lexical positions) does not hit this.
    it.fails(
      "RED-TEAM FINDING (scalar-offset misuse): random scalar-offset inserts eventually shatter a surrogate",
      () => {
        // A small deterministic fuzz over a string with emoji, using SCALAR offsets (Array.from).
        let model = "😀a😎b🎉c";
        const t = fresh(model);
        const inserts: Array<[number, string]> = [
          [1, "_"],
          [3, "-"],
          [5, "+"],
          [0, "^"],
        ];
        for (const [scalarOff, s] of inserts) {
          insertTextAt(t, scalarOff, s);
        }
        // If the function respected SCALAR offsets, no emoji would ever be split.
        expect(hasSurrogateCorruption(toText(t)), `text=${JSON.stringify(toText(t))}`).to.equal(false);
      },
    );
  });
});
