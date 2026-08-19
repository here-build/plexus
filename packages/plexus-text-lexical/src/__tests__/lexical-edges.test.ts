import { createHeadlessEditor } from "@lexical/headless";
import { Plexus } from "@here.build/plexus";
import { addMark, insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { $createTextNode, $getRoot, type ElementNode, type LexicalEditor, type TextNode } from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindLexical } from "../index.js";

// ── setup helpers (copied from lexical.test.ts) ──────────────────────────────────
let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `lex-edge-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: "test",
    nodes: [],
    onError: (e) => {
      throw e;
    },
  });
}

function editorText(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

/** Extended run reader: text + bold + italic flags per Lexical TextNode. */
function editorRuns(editor: LexicalEditor): { text: string; bold: boolean; italic: boolean }[] {
  return editor.getEditorState().read(() => {
    const p = $getRoot().getFirstChild() as ElementNode | null;
    if (p === null) return [];
    return p.getChildren().map((node) => ({
      text: node.getTextContent(),
      bold: (node as TextNode).hasFormat("bold"),
      italic: (node as TextNode).hasFormat("italic"),
    }));
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

describe("plexus-text-lexical — edge cases", () => {
  // 1. Multiple non-overlapping marks (bold + italic on different ranges) project correctly.
  it("bold and italic on disjoint ranges project to the right format runs", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindLexical(ed, text, doc);

    insertTextAt(text, 0, "boldnormitalic");
    addMark(text, 0, 4, "bold"); // "bold"
    addMark(text, 8, 14, "italic"); // "italic"

    expect(editorRuns(ed)).to.deep.equal([
      { text: "bold", bold: true, italic: false },
      { text: "norm", bold: false, italic: false },
      { text: "italic", bold: false, italic: true },
    ]);

    unbind();
  });

  // 2. Multiple sequential edits A → model → B.
  it("multiple sequential edits in A each reach B's editor", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    edA.update(() => ($getRoot().getFirstChild() as ElementNode).append($createTextNode("hello")), { discrete: true });
    sync(docA, docB);
    expect(editorText(edB)).to.equal("hello");

    // append " world" by replacing the single text node's content
    edA.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        p.clear();
        p.append($createTextNode("hello world"));
      },
      { discrete: true },
    );
    sync(docA, docB);
    expect(toText(textA)).to.equal("hello world");
    expect(editorText(edB)).to.equal("hello world");

    // shrink to "hi world"
    edA.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        p.clear();
        p.append($createTextNode("hi world"));
      },
      { discrete: true },
    );
    sync(docA, docB);
    expect(toText(textA)).to.equal("hi world");
    expect(editorText(edB)).to.equal("hi world");

    unbindA();
    unbindB();
  });

  // 3. Empty-doc round-trip: bind with no content, type, sync.
  it("empty-doc round trip: bind empty, type in A, reaches B", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    // both start empty
    expect(toText(textA)).to.equal("");
    expect(editorText(edA)).to.equal("");
    expect(editorText(edB)).to.equal("");

    edA.update(() => ($getRoot().getFirstChild() as ElementNode).append($createTextNode("first")), { discrete: true });
    expect(toText(textA)).to.equal("first");
    sync(docA, docB);
    expect(toText(textB)).to.equal("first");
    expect(editorText(edB)).to.equal("first");

    unbindA();
    unbindB();
  });

  // 4. Overlapping bold + italic → a run that carries BOTH formats.
  it("overlapping bold + italic yields a run with both formats", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindLexical(ed, text, doc);

    insertTextAt(text, 0, "abcdef");
    addMark(text, 0, 4, "bold"); // "abcd" bold
    addMark(text, 2, 6, "italic"); // "cdef" italic → "cd" is both

    // expected runs: "ab" bold, "cd" bold+italic, "ef" italic
    expect(editorRuns(ed)).to.deep.equal([
      { text: "ab", bold: true, italic: false },
      { text: "cd", bold: true, italic: true },
      { text: "ef", bold: false, italic: true },
    ]);

    unbind();
  });

  // Extra: a mark added on peer A projects through the model into peer B's editor runs.
  it("a mark added in A's model projects as a format run in B's editor", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);

    const { doc: docB, text: textB } = makePeerB(docA);
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    insertTextAt(textA, 0, "hello world");
    sync(docA, docB);
    addMark(textA, 0, 5, "bold");
    sync(docA, docB);

    expect(editorRuns(edB)).to.deep.equal([
      { text: "hello", bold: true, italic: false },
      { text: " world", bold: false, italic: false },
    ]);

    unbindA();
    unbindB();
  });
});
