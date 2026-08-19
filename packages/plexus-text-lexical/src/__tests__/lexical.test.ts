import { createHeadlessEditor } from "@lexical/headless";
import { Plexus } from "@here.build/plexus";
import { addMark, insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { $createTextNode, $getRoot, type ElementNode, type LexicalEditor, type TextNode } from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindLexical } from "../index.js";

let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `lex-${n++}`;
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

function editorRuns(editor: LexicalEditor): { text: string; bold: boolean }[] {
  return editor.getEditorState().read(() => {
    const p = $getRoot().getFirstChild() as ElementNode | null;
    if (p === null) return [];
    return p.getChildren().map((node) => ({
      text: node.getTextContent(),
      bold: (node as TextNode).hasFormat("bold"),
    }));
  });
}

describe("plexus-text-lexical — inline two-way binding", () => {
  it("typing in peer A's editor reaches peer B's editor", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    // simulate typing "hello" in A's editor (discrete = synchronous, like a keystroke commit)
    edA.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        p.append($createTextNode("hello"));
      },
      { discrete: true },
    );
    expect(toText(textA)).to.equal("hello"); // outbound: editor → model

    // sync A → B
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    expect(toText(textB)).to.equal("hello"); // model converged
    expect(editorText(edB)).to.equal("hello"); // inbound: model → editor

    unbindA();
    unbindB();
  });

  it("a model mark projects into a Lexical format run", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindLexical(ed, text, doc);

    insertTextAt(text, 0, "hello world");
    addMark(text, 0, 5, "bold");

    expect(editorRuns(ed)).to.deep.equal([
      { text: "hello", bold: true },
      { text: " world", bold: false },
    ]);

    unbind();
  });

  it("two live bindings: concurrent typing converges with no echo or duplication", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, docA);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, docB);

    // both peers type concurrently, before any sync
    edA.update(() => ($getRoot().getFirstChild() as ElementNode).append($createTextNode("AAA")), { discrete: true });
    edB.update(() => ($getRoot().getFirstChild() as ElementNode).append($createTextNode("BBB")), { discrete: true });
    expect(toText(textA)).to.equal("AAA");
    expect(toText(textB)).to.equal("BBB");

    // sync both ways
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    const merged = toText(textA);
    expect(merged.length).to.equal(6); // AAA + BBB, no echo-duplication (not 12)
    expect(toText(textB)).to.equal(merged); // models converge
    expect(editorText(edA)).to.equal(merged); // edA reflects the merge, didn't re-apply its own edit
    expect(editorText(edB)).to.equal(merged);

    unbindA();
    unbindB();
  });
});
