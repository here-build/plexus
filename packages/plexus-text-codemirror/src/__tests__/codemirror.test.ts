import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyCmChange, plexusTextSync, textDiff } from "../index.js";

let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `cm-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}

function seed(text: PlexusText, s: string): void {
  insertTextAt(text, 0, s);
}

/** Drive a real CodeMirror ChangeSet through the outbound translation (high-offset-first). */
function applyChangeSet(text: PlexusText, doc: string, change: { from: number; to?: number; insert?: string }): void {
  const tr = EditorState.create({ doc }).update({ changes: change });
  const edits: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fA, tA, _f, _t, ins) => edits.push({ from: fA, to: tA, insert: ins.toString() }));
  for (let i = edits.length - 1; i >= 0; i--) applyCmChange(text, edits[i].from, edits[i].to, edits[i].insert);
}

describe("plexus-text-codemirror — flat-text two-way translation", () => {
  it("textDiff produces a minimal single replace", () => {
    expect(textDiff("hello world", "hello there")).to.deep.equal({ from: 6, to: 11, insert: "there" });
    expect(textDiff("abc", "abc")).to.equal(null);
    expect(textDiff("", "hi")).to.deep.equal({ from: 0, to: 0, insert: "hi" });
    expect(textDiff("hi", "")).to.deep.equal({ from: 0, to: 2, insert: "" });
  });

  it("applies a real CodeMirror ChangeSet (replace) to the content", () => {
    const { root } = makeText();
    seed(root, "hello world");
    applyChangeSet(root, "hello world", { from: 6, to: 11, insert: "there" });
    expect(toText(root)).to.equal("hello there");
  });

  it("maps an insert at the end of the text", () => {
    const { root } = makeText();
    seed(root, "hello");
    applyCmChange(root, 5, 5, " world");
    expect(toText(root)).to.equal("hello world");
  });

  it("two peers: A's edit syncs, and B derives the right inbound CM change", () => {
    const { doc: docA, root: rootA } = makeText();
    seed(rootA, "hello");
    applyCmChange(rootA, 5, 5, " world"); // simulate a local CM edit
    expect(toText(rootA)).to.equal("hello world");

    // sync A → a fresh peer B
    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const rootB = Plexus.connect(docB).root as PlexusText;
    expect(toText(rootB)).to.equal("hello world");

    // B's editor showed the pre-sync "hello"; the inbound diff is the exact CM change to apply.
    expect(textDiff("hello", toText(rootB))).to.deep.equal({ from: 5, to: 5, insert: " world" });
  });

  it("two LIVE bindings: a user edit in A reaches B's view, no echo on A", () => {
    const { doc: docA, root: textA } = makeText();
    seed(textA, "hello");
    const viewA = new EditorView({ doc: "hello", extensions: [plexusTextSync(textA, docA)], parent: document.createElement("div") });

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const viewB = new EditorView({ doc: toText(textB), extensions: [plexusTextSync(textB, docB)], parent: document.createElement("div") });

    viewA.dispatch({ changes: { from: 5, insert: " world" } }); // user types " world"
    expect(toText(textA)).to.equal("hello world"); // outbound: view → model
    expect(viewA.state.doc.toString()).to.equal("hello world"); // no echo re-applied it

    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    expect(toText(textB)).to.equal("hello world");
    expect(viewB.state.doc.toString()).to.equal("hello world"); // inbound: model → view

    viewA.destroy();
    viewB.destroy();
  });

  it("two LIVE bindings: concurrent typing converges with no echo-duplication", () => {
    const { doc: docA, root: textA } = makeText();
    const viewA = new EditorView({ doc: "", extensions: [plexusTextSync(textA, docA)], parent: document.createElement("div") });

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const viewB = new EditorView({ doc: toText(textB), extensions: [plexusTextSync(textB, docB)], parent: document.createElement("div") });

    viewA.dispatch({ changes: { from: 0, insert: "AAA" } });
    viewB.dispatch({ changes: { from: 0, insert: "BBB" } });

    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    const merged = toText(textA);
    expect(merged.length).to.equal(6); // AAA + BBB, not 12
    expect(toText(textB)).to.equal(merged);
    expect(viewA.state.doc.toString()).to.equal(merged);
    expect(viewB.state.doc.toString()).to.equal(merged);

    viewA.destroy();
    viewB.destroy();
  });
});
