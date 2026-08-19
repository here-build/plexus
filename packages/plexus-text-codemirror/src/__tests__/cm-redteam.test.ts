import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { addMark, deleteTextRange, insertTextAt, PlexusText, segments, toText } from "@here.build/plexus-text";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyCmChange, plexusTextSync, textDiff } from "../index.js";

/**
 * RED-TEAM suite for the CodeMirror ↔ PlexusText binding.
 *
 * Mission: break the claim that a user edit flows view→model→other-view with no echo,
 * no duplication, no loss — under rapid / concurrent / re-entrant / Unicode conditions.
 *
 * Verdict (see end of file): the CM binding SURVIVES every weaponizable attack. The one
 * real defect found is a latent `textDiff` surrogate-pair split (the FAILING test below),
 * which CodeMirror's own ChangeSet sanitizer currently masks on the inbound path and which
 * CM's whole-codepoint outbound offsets never trigger. It is a live kill on the *Lexical*
 * binding (see lexical-redteam.test.ts), so it is recorded here as the shared root cause.
 */

// ── setup helpers (copied from codemirror-edges.test.ts) ─────────────────────────
let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `cm-redteam-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}
function seed(text: PlexusText, s: string): void {
  insertTextAt(text, 0, s);
}
function makePeerB(docA: Y.Doc): { doc: Y.Doc; text: PlexusText } {
  const docB = new Y.Doc({ guid: docA.guid });
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const textB = Plexus.connect(docB).root as PlexusText;
  return { doc: docB, text: textB };
}
function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}
function liveView(doc: Y.Doc, text: PlexusText): EditorView {
  return new EditorView({ doc: toText(text), extensions: [plexusTextSync(text, doc)], parent: document.createElement("div") });
}

describe("plexus-text-codemirror — RED TEAM (attacks that the binding survives)", () => {
  // VECTOR 1 — rapid-fire sequential edits: 12 dispatches in a row, each before the next.
  it("ATTACK 1 (survives): 12 rapid sequential edits each reach peer B exactly once", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    for (let i = 0; i < 12; i++) viewA.dispatch({ changes: { from: viewA.state.doc.length, insert: String(i % 10) } });
    sync(docA, docB);

    // no drop, no double — exactly 12 chars in append order
    expect(toText(textA)).to.equal("012345678901");
    expect(viewA.state.doc.toString()).to.equal("012345678901"); // no echo grew it
    expect(viewB.state.doc.toString()).to.equal("012345678901");

    viewA.destroy();
    viewB.destroy();
  });

  // VECTOR 2 — echo loop: A types, then sync both ways five times. If B's inbound render
  // re-emitted an outbound that ricocheted to A, text would grow / oscillate.
  it("ATTACK 2 (survives): ping-pong sync five times — no echo growth or oscillation", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    viewA.dispatch({ changes: { from: 0, insert: "hi" } });
    for (let i = 0; i < 5; i++) {
      sync(docA, docB);
      sync(docB, docA);
    }

    expect(toText(textA)).to.equal("hi");
    expect(toText(textB)).to.equal("hi");
    expect(viewA.state.doc.toString()).to.equal("hi");
    expect(viewB.state.doc.toString()).to.equal("hi");

    viewA.destroy();
    viewB.destroy();
  });

  // VECTOR 4 — multi-change single CM transaction (CM batches disjoint changes): all applied.
  it("ATTACK 4 (survives): one CM transaction with two disjoint changes applies both correctly", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "the quick brown fox");
    const viewA = liveView(docA, textA);

    // CM batches these into ONE transaction; the binding must apply both, high-offset-first.
    viewA.dispatch({ changes: [{ from: 4, to: 9, insert: "slow" }, { from: 10, to: 15, insert: "red" }] });

    expect(toText(textA)).to.equal("the slow red fox");
    expect(viewA.state.doc.toString()).to.equal("the slow red fox");

    viewA.destroy();
  });

  // VECTOR 7 — emoji adjacency through a live binding (NOT replacement). Surrogate pair stays whole.
  it("ATTACK 7a (survives): inserting next to an emoji keeps the surrogate pair intact across peers", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    viewA.dispatch({ changes: { from: 0, insert: "a😀b" } });
    sync(docA, docB);
    expect(toText(textB)).to.equal("a😀b");

    // insert 'Z' between the emoji and 'b' (CM offset 3, just past the 2-unit emoji)
    viewA.dispatch({ changes: { from: 3, insert: "Z" } });
    sync(docA, docB);
    expect(toText(textA)).to.equal("a😀Zb");
    expect(viewB.state.doc.toString()).to.equal("a😀Zb");
    expect([...toText(textA)].length).to.equal(4); // 4 codepoints, emoji not split

    viewA.destroy();
    viewB.destroy();
  });

  // VECTOR 7 — realistic emoji REPLACEMENT through a live binding. CM emits whole-codepoint
  // offsets (selecting both UTF-16 units), so the outbound model write stays clean.
  it("ATTACK 7b (survives): selecting an emoji and replacing it keeps the model clean (CM gives whole-codepoint offsets)", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);
    viewA.dispatch({ changes: { from: 0, insert: "😀" } });

    // user selects the whole emoji (offsets 0..2) and types a different one
    viewA.dispatch({ changes: { from: 0, to: 2, insert: "😁" } });

    expect(toText(textA)).to.equal("😁");
    expect(viewA.state.doc.toString()).to.equal("😁");
    expect(toText(textA).codePointAt(0)).to.equal(0x1f601); // a real codepoint, not a lone surrogate
    expect(toText(textA)).not.to.contain("�");

    viewA.destroy();
  });

  // VECTOR 7 — inbound emoji replace: a remote model edit replaces 😀→😁; the binding's
  // textDiff yields a surrogate-splitting change, but CM's ChangeSet sanitizes it.
  it("ATTACK 7c (survives): inbound emoji replace is sanitized by CM, view + model stay in sync", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);
    viewA.dispatch({ changes: { from: 0, insert: "😀" } });
    const { doc: docB, text: textB } = makePeerB(docA);

    // peer B replaces the emoji at the model level (whole-codepoint)
    deleteTextRange(textB, 0, 2);
    insertTextAt(textB, 0, "😁");
    sync(docB, docA); // A's onUpdate computes textDiff("😀","😁") and dispatches it

    expect(viewA.state.doc.toString()).to.equal("😁");
    expect(toText(textA)).to.equal("😁");
    expect(viewA.state.doc.toString()).to.equal(toText(textA));

    viewA.destroy();
  });

  // VECTOR 8 — whitespace / newline-only edits propagate verbatim.
  it("ATTACK 8 (survives): newline + whitespace-only edit propagates byte-exact to peer B", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    viewA.dispatch({ changes: { from: 0, insert: "line1\nline2\n\n   " } });
    sync(docA, docB);

    expect(toText(textA)).to.equal("line1\nline2\n\n   ");
    expect(viewB.state.doc.toString()).to.equal("line1\nline2\n\n   ");

    viewA.destroy();
    viewB.destroy();
  });

  // VECTOR — editing at a model marker boundary: a bold mark embed sits in the sequence;
  // a flat CM edit must map past the zero-width embed without offset drift.
  it("ATTACK (survives): a flat CM edit at a bold-marker boundary maps past the zero-width embed", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "hello world");
    addMark(textA, 0, 5, "bold"); // bold "hello"; two embeds now live in the sequence
    const viewA = liveView(docA, textA);

    expect(viewA.state.doc.toString()).to.equal("hello world"); // embeds are zero-width to CM

    viewA.dispatch({ changes: { from: 5, insert: "!" } }); // type at the bold boundary
    expect(toText(textA)).to.equal("hello! world");
    expect(viewA.state.doc.toString()).to.equal("hello! world");
    // projection still valid — "hello!" stays bold, " world" plain
    expect(segments(textA)).to.deep.equal([
      { text: "hello!", marks: { bold: true } },
      { text: " world", marks: {} },
    ]);

    viewA.destroy();
  });
});

describe("plexus-text-codemirror — RED TEAM (FIXED: textDiff is now surrogate-aware)", () => {
  /**
   * RED-TEAM FINDING (FIXED) — textDiff no longer splits surrogate pairs.
   *
   * `textDiff` scans shared prefix/suffix by UTF-16 code unit. Two emoji that share a high
   * surrogate (😀 = D83D DE00, 😁 = D83D DE01) match on the high half. The OLD diff became
   * { from: 1, to: 2, insert: "\uDE01" } — it cut one half of a pair and inserted a lone low
   * surrogate (malformed UTF-16). The fix backs the prefix/suffix boundaries off any surrogate
   * pair: if the matched prefix ends on a high surrogate (or the suffix starts on a low
   * surrogate), the boundary is pulled back so the WHOLE codepoint is replaced.
   *
   * This was the shared root cause of the live Lexical content-corruption kill; with textDiff
   * surrogate-safe, the Lexical binding is now clean too (see lexical-redteam.test.ts KILL #1).
   */
  it("FIXED: textDiff replaces the whole emoji when two emoji share a high surrogate", () => {
    const diff = textDiff("😀", "😁");
    // surrogate-aware diff replaces the whole codepoint, not one half.
    expect(diff).to.deep.equal({ from: 0, to: 2, insert: "😁" });
  });

  it("FIXED: applying that whole-codepoint diff to the model yields a clean emoji, no lone surrogate", () => {
    const { root } = makeText();
    insertTextAt(root, 0, "😀");
    const diff = textDiff(toText(root), "😁")!; // { from:0, to:2, insert:"😁" }
    applyCmChange(root, diff.from, diff.to, diff.insert);
    // clean 😁 — one whole codepoint, no replacement char, no lone surrogate.
    expect(toText(root)).to.equal("😁");
    expect([...toText(root)].length).to.equal(1);
    expect(toText(root).codePointAt(0)).to.equal(0x1f601);
    expect(toText(root)).not.to.contain("�");
  });
});
