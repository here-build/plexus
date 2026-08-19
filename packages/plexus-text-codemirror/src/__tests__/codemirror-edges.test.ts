import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyCmChange, plexusTextSync, textDiff } from "../index.js";

// ── setup helpers (copied from codemirror.test.ts) ───────────────────────────────
let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `cm-edge-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}

function seed(text: PlexusText, s: string): void {
  insertTextAt(text, 0, s);
}

/** Bootstrap a second live peer B from A, both bound to live EditorViews. */
function makePeerB(docA: Y.Doc): { doc: Y.Doc; text: PlexusText } {
  const docB = new Y.Doc({ guid: docA.guid });
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const textB = Plexus.connect(docB).root as PlexusText;
  return { doc: docB, text: textB };
}

/** Pump A → B over the wire (the binding's doc.on("update") drives the inbound diff). */
function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function liveView(doc: Y.Doc, text: PlexusText): EditorView {
  return new EditorView({
    doc: toText(text),
    extensions: [plexusTextSync(text, doc)],
    parent: document.createElement("div"),
  });
}

describe("plexus-text-codemirror — edge cases", () => {
  // 1. Multi-character insert, delete-range, replace via live EditorView; both peers checked.
  it("multi-character insert propagates to model and the other peer's view", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "hello");
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    viewA.dispatch({ changes: { from: 5, insert: " bright world" } });
    expect(toText(textA)).to.equal("hello bright world");
    expect(viewA.state.doc.toString()).to.equal("hello bright world");

    sync(docA, docB);
    expect(toText(textB)).to.equal("hello bright world");
    expect(viewB.state.doc.toString()).to.equal("hello bright world");

    viewA.destroy();
    viewB.destroy();
  });

  it("delete-range removes a span in model and the other peer's view", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "hello bright world");
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    // delete " bright" → "hello world"
    viewA.dispatch({ changes: { from: 5, to: 12, insert: "" } });
    expect(toText(textA)).to.equal("hello world");
    expect(viewA.state.doc.toString()).to.equal("hello world");

    sync(docA, docB);
    expect(toText(textB)).to.equal("hello world");
    expect(viewB.state.doc.toString()).to.equal("hello world");

    viewA.destroy();
    viewB.destroy();
  });

  it("replace (delete+insert in one change) propagates to model and the other peer's view", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "hello world");
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    // replace "world" → "there"
    viewA.dispatch({ changes: { from: 6, to: 11, insert: "there" } });
    expect(toText(textA)).to.equal("hello there");
    expect(viewA.state.doc.toString()).to.equal("hello there");

    sync(docA, docB);
    expect(toText(textB)).to.equal("hello there");
    expect(viewB.state.doc.toString()).to.equal("hello there");

    viewA.destroy();
    viewB.destroy();
  });

  // 2. Several sequential user edits in one view, each propagating to a second live view.
  it("several sequential edits in A each reach B's view", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    // edit 1: type "abc"
    viewA.dispatch({ changes: { from: 0, insert: "abc" } });
    sync(docA, docB);
    expect(viewB.state.doc.toString()).to.equal("abc");

    // edit 2: append "def" at the end
    viewA.dispatch({ changes: { from: 3, insert: "def" } });
    sync(docA, docB);
    expect(viewB.state.doc.toString()).to.equal("abcdef");

    // edit 3: replace "cd" in the middle with "X"
    viewA.dispatch({ changes: { from: 2, to: 4, insert: "X" } });
    sync(docA, docB);
    expect(toText(textA)).to.equal("abXef");
    expect(viewB.state.doc.toString()).to.equal("abXef");

    // edit 4: delete the first char
    viewA.dispatch({ changes: { from: 0, to: 1, insert: "" } });
    sync(docA, docB);
    expect(toText(textA)).to.equal("bXef");
    expect(viewB.state.doc.toString()).to.equal("bXef");

    viewA.destroy();
    viewB.destroy();
  });

  // 3. Edit at offset 0 and at the very end.
  it("insert at offset 0 (prepend) propagates", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "world");
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    viewA.dispatch({ changes: { from: 0, insert: "hello " } });
    expect(toText(textA)).to.equal("hello world");
    sync(docA, docB);
    expect(viewB.state.doc.toString()).to.equal("hello world");

    viewA.destroy();
    viewB.destroy();
  });

  it("insert at the very end (append) propagates", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "hello");
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    const end = viewA.state.doc.length;
    viewA.dispatch({ changes: { from: end, insert: "!" } });
    expect(toText(textA)).to.equal("hello!");
    sync(docA, docB);
    expect(viewB.state.doc.toString()).to.equal("hello!");

    viewA.destroy();
    viewB.destroy();
  });

  // 4. textDiff on tricky pairs.
  it("textDiff: common prefix AND suffix → minimal middle replace", () => {
    // "abXYZcd" → "abQcd": shared prefix "ab", shared suffix "cd", middle XYZ→Q
    expect(textDiff("abXYZcd", "abQcd")).to.deep.equal({ from: 2, to: 5, insert: "Q" });
  });

  it("textDiff: full replacement (no shared prefix/suffix)", () => {
    expect(textDiff("abc", "xyz")).to.deep.equal({ from: 0, to: 3, insert: "xyz" });
  });

  it("textDiff: insert-only in the middle", () => {
    // "abcd" → "abXcd": pure insert of "X" at offset 2, nothing deleted
    expect(textDiff("abcd", "abXcd")).to.deep.equal({ from: 2, to: 2, insert: "X" });
  });

  it("textDiff: delete-only in the middle", () => {
    // "abXcd" → "abcd": pure delete of "X", nothing inserted
    expect(textDiff("abXcd", "abcd")).to.deep.equal({ from: 2, to: 3, insert: "" });
  });

  it("textDiff: identical strings → null", () => {
    expect(textDiff("abc", "abc")).to.equal(null);
    expect(textDiff("", "")).to.equal(null);
  });

  it("textDiff: repeated-char boundary (prefix/suffix scan must not overlap)", () => {
    // "aaa" → "aa": one char deleted; from/to must stay within bounds (no negative-length slice)
    expect(textDiff("aaa", "aa")).to.deep.equal({ from: 2, to: 3, insert: "" });
    // "aa" → "aaa": one char inserted
    expect(textDiff("aa", "aaa")).to.deep.equal({ from: 2, to: 2, insert: "a" });
  });

  // 5. A delete that empties the doc, then re-typing.
  it("delete-to-empty then re-type, both via applyCmChange (pure model path)", () => {
    const { root } = makeText();
    seed(root, "hello world");

    applyCmChange(root, 0, 11, ""); // wipe everything
    expect(toText(root)).to.equal("");

    applyCmChange(root, 0, 0, "fresh"); // re-type into the empty doc
    expect(toText(root)).to.equal("fresh");
  });

  it("delete-to-empty then re-type via a live view, reaching the other peer", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "gone soon");
    const viewA = liveView(docA, textA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const viewB = liveView(docB, textB);

    // empty the doc
    viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: "" } });
    expect(toText(textA)).to.equal("");
    expect(viewA.state.doc.toString()).to.equal("");
    sync(docA, docB);
    expect(toText(textB)).to.equal("");
    expect(viewB.state.doc.toString()).to.equal("");

    // re-type
    viewA.dispatch({ changes: { from: 0, insert: "reborn" } });
    expect(toText(textA)).to.equal("reborn");
    sync(docA, docB);
    expect(toText(textB)).to.equal("reborn");
    expect(viewB.state.doc.toString()).to.equal("reborn");

    viewA.destroy();
    viewB.destroy();
  });
});
