import { createHeadlessEditor } from "@lexical/headless";
import { Plexus } from "@here.build/plexus";
import { addMark, insertTextAt, PlexusText, segments, toText } from "@here.build/plexus-text";
import { $createTextNode, $getRoot, type ElementNode, type LexicalEditor, type TextNode } from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindLexical } from "../index.js";

/**
 * RED-TEAM suite for the Lexical ↔ PlexusText binding.
 *
 * Mission: break the claim that a user edit flows editor→model→other-editor with no echo,
 * no duplication, no loss — under rapid / concurrent / re-entrant / Unicode conditions.
 *
 * Verdict (see end of file): the echo guard, duplication and convergence claims HOLD. But
 * two genuine content-loss kills were found:
 *   1. Emoji replacement corrupts the model to a lone surrogate (textDiff surrogate split
 *      fed straight into Y.Text — no sanitizer in this binding, unlike CodeMirror).
 *   2. Editor-applied formatting is silently destroyed by the next inbound whole-paragraph
 *      re-render (outbound syncs text only; the source comment calls format "inbound-only").
 *
 * NOTE: per the brief, the known whole-paragraph-re-render *cursor* loss is NOT reported as
 * a find. The findings below are CONTENT loss (a corrupted codepoint, a wiped format run).
 */

// ── setup helpers (copied from lexical-edges.test.ts) ────────────────────────────
let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `lex-redteam-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}
function makeEditor(): LexicalEditor {
  return createHeadlessEditor({ namespace: "test", nodes: [], onError: (e) => { throw e; } });
}
function editorText(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}
function editorRuns(editor: LexicalEditor): { text: string; bold: boolean }[] {
  return editor.getEditorState().read(() => {
    const p = $getRoot().getFirstChild() as ElementNode | null;
    if (p === null) return [];
    return p.getChildren().map((node) => ({ text: node.getTextContent(), bold: (node as TextNode).hasFormat("bold") }));
  });
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
/** Simulate a keystroke commit: append a text node, discrete (synchronous). */
function typeIn(ed: LexicalEditor, s: string): void {
  ed.update(() => ($getRoot().getFirstChild() as ElementNode).append($createTextNode(s)), { discrete: true });
}
/** Replace the whole paragraph's text (a user retyping a selection). */
function setText(ed: LexicalEditor, s: string): void {
  ed.update(() => {
    const p = $getRoot().getFirstChild() as ElementNode;
    p.clear();
    if (s.length > 0) p.append($createTextNode(s));
  }, { discrete: true });
}

describe("plexus-text-lexical — RED TEAM (attacks the binding survives)", () => {
  // VECTOR 1 — rapid sequential edits.
  it("ATTACK 1 (survives): 10 rapid sequential edits reach peer B exactly, no drop/double", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    let acc = "";
    for (let i = 0; i < 10; i++) {
      acc += String(i);
      setText(edA, acc);
    }
    sync(docA, docB);

    expect(toText(textA)).to.equal("0123456789");
    expect(editorText(edB)).to.equal("0123456789");

    unbindA();
    unbindB();
  });

  // VECTOR 2 — echo loop: type once, then sync both ways five times.
  it("ATTACK 2 (survives): ping-pong sync five times — no echo growth, both editors stable", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    typeIn(edA, "hi");
    for (let i = 0; i < 5; i++) {
      sync(docA, docB);
      sync(docB, docA);
    }

    expect(toText(textA)).to.equal("hi");
    expect(toText(textB)).to.equal("hi");
    expect(editorText(edA)).to.equal("hi");
    expect(editorText(edB)).to.equal("hi");

    unbindA();
    unbindB();
  });

  // VECTOR 2 — bidirectional editing: A types, syncs to B, B appends, syncs back. No dup.
  it("ATTACK 2b (survives): A types then B appends then syncs back — A shows the concatenation once", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    typeIn(edA, "ABCDE");
    sync(docA, docB);
    expect(editorText(edB)).to.equal("ABCDE");

    typeIn(edB, "FG");
    sync(docB, docA);

    expect(toText(textA)).to.equal("ABCDEFG"); // no echo doubled it
    expect(editorText(edA)).to.equal("ABCDEFG");

    unbindA();
    unbindB();
  });

  // VECTOR 3 — concurrent text + formatting on the same region: must converge.
  it("ATTACK 3 (survives): A types while B bolds the same region — converges, no stale/dup run", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);
    insertTextAt(textA, 0, "shared");
    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    setText(edA, "sharedX"); // A appends a char
    addMark(textB, 0, 6, "bold"); // B bolds "shared" concurrently
    sync(docA, docB);
    sync(docB, docA);

    expect(toText(textA)).to.equal("sharedX");
    expect(toText(textB)).to.equal("sharedX");
    // The two peers CONVERGE identically — the SEC claim. Whether the trailing "X" lands inside
    // or just outside the bold span is a genuine CRDT tie-break (A's insert at end vs B's close
    // embed at offset 6 share a position; yjs breaks the tie by item id). BOTH outcomes are
    // valid convergence; the test must not over-specify which tie wins, only that:
    //   - both editors agree (no divergence),
    //   - "shared" is fully bold (the span definitely covers it),
    //   - "X" appears exactly once, contiguous, no stale/duplicated run.
    expect(editorRuns(edB)).to.deep.equal(editorRuns(edA));
    const runs = editorRuns(edA);
    expect(runs.map((r) => r.text).join("")).to.equal("sharedX"); // exactly once, in order
    // "shared" is bold: every code unit of "shared" carries bold (it may merge with a bold "X").
    const boldText = runs
      .filter((r) => r.bold)
      .map((r) => r.text)
      .join("");
    expect(boldText.startsWith("shared")).to.equal(true);
    expect(["sharedX", "shared"]).to.contain(boldText); // X bold-or-plain, both valid ties

    unbindA();
    unbindB();
  });

  // VECTOR 6 — unbind during in-flight: after unbind, neither direction may mutate.
  it("ATTACK 6 (survives): after unbind, a model change does not touch the editor, and vice-versa", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindLexical(ed, text, doc);
    typeIn(ed, "alive");
    expect(toText(text)).to.equal("alive");

    unbind();

    insertTextAt(text, 5, " dead"); // model mutated after unbind
    expect(editorText(ed)).to.equal("alive"); // editor NOT re-rendered

    typeIn(ed, "X"); // editor mutated after unbind
    expect(toText(text)).to.equal("alive dead"); // model NOT touched by editor

    // calling unbind again is a no-op (no throw, no leak)
    expect(() => unbind()).not.to.throw();
  });

  // VECTOR 7 — emoji adjacency (not replacement): whole-codepoint boundaries → safe.
  it("ATTACK 7a (survives): typing next to an emoji keeps the surrogate pair intact", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindLexical(ed, text, doc);
    typeIn(ed, "a😀b");
    expect(toText(text)).to.equal("a😀b");
    setText(ed, "a😀Zb"); // insert 'Z' adjacent to the emoji
    expect(toText(text)).to.equal("a😀Zb");
    expect([...toText(text)].length).to.equal(4); // 4 codepoints, emoji unsplit
    unbind();
  });

  // VECTOR 8 — whitespace / newline edits.
  it("ATTACK 8 (survives): whitespace/newline content round-trips to peer B byte-exact", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);
    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    setText(edA, "line1\nline2\n\n   ");
    sync(docA, docB);

    expect(toText(textA)).to.equal("line1\nline2\n\n   ");
    expect(editorText(edB)).to.equal("line1\nline2\n\n   ");

    unbindA();
    unbindB();
  });
});

describe("plexus-text-lexical — RED TEAM (genuine kills)", () => {
  /**
   * RED-TEAM FINDING #1 (FIXED) — emoji replacement no longer corrupts the model.
   *
   * Repro: type 😀, then replace it with 😁 in the editor. Outbound `syncText` computes
   * `textDiff("😀","😁")` and applies it to the Y.Text via deleteTextRange/insertTextAt. The
   * OLD textDiff matched the shared high surrogate D83D and returned { from: 1, to: 2,
   * insert: "\uDE01" }, splitting both pairs → the model became "�\uDE01" (replacement char +
   * lone low surrogate), permanently desynced from the editor. The FIX makes textDiff
   * surrogate-aware: it backs the prefix/suffix boundaries off any surrogate pair, so the diff
   * is { from: 0, to: 2, insert: "😁" } — the whole codepoint is replaced cleanly.
   *
   * model === editor === "😁", no replacement char, no lone surrogate.
   */
  it("FIXED #1: replacing an emoji keeps the model clean — model === editor === 😁, no surrogate split", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindLexical(ed, text, doc);

    typeIn(ed, "😀");
    expect(toText(text)).to.equal("😀");

    setText(ed, "😁"); // user selects the emoji and types a different one

    // editor and model agree, and the model holds a clean codepoint.
    expect(toText(text)).to.equal("😁");
    expect(toText(text)).to.equal(editorText(ed));
    expect(toText(text)).not.to.contain("�");
    expect([...toText(text)].length).to.equal(1);
    expect(toText(text).codePointAt(0)).to.equal(0x1f601);

    unbind();
  });

  /**
   * FIXED: editor-applied bold reaches the model (format outbound) and survives a remote
   * text edit. Was RED-TEAM FINDING #2 — whole-paragraph re-render wiped un-modelled formats.
   *
   * Note: insert at char offset 0 when bold covers [0,n) lands *inside* the Start/End
   * pair (after Start) — correct geometry, so the prepend inherits bold. The wipe-bug
   * was "bold disappears entirely"; we assert bold still present after re-render.
   */
  it("FIXED: editor-applied bold survives a remote text edit (format outbound)", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);

    // user types bold "hello" in the editor
    edA.update(() => {
      const node = $createTextNode("hello");
      node.toggleFormat("bold");
      ($getRoot().getFirstChild() as ElementNode).append(node);
    }, { discrete: true });
    expect(editorRuns(edA)).to.deep.equal([{ text: "hello", bold: true }]);
    // format outbound: bold is in the model
    expect(segments(textA)).to.deep.equal([{ text: "hello", marks: { bold: true } }]);

    // collaborator joins AFTER content exists and inserts (triggers re-render on A)
    const { doc: docB, text: textB } = makePeerB(docA);
    insertTextAt(textB, 0, "X");
    sync(docB, docA);

    expect(toText(textA)).to.equal("Xhello");
    // bold still present in model + editor after inbound re-render (not wiped to plain)
    expect(segments(textA).some((s) => s.marks.bold === true)).to.equal(true);
    expect(editorRuns(edA).some((r) => r.bold)).to.equal(true);

    unbindA();
  });
});
