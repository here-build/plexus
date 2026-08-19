import { Plexus } from "@here.build/plexus";
import { addMark, insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { Editor, type Operation, Transforms } from "slate";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindPlate, createPlateBoundEditor } from "../index.js";

let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `plate-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}

function makeEditor(): Editor {
  return createPlateBoundEditor();
}

function editorText(editor: Editor): string {
  if (editor.children.length === 0) return "";
  return Editor.string(editor, [0]);
}

function editorRuns(editor: Editor): { text: string; bold: boolean }[] {
  const para = editor.children[0] as { children: Array<{ text: string; bold?: boolean }> };
  const out: { text: string; bold: boolean }[] = [];
  for (const leaf of para.children) {
    if (leaf.text.length === 0) continue;
    const bold = !!leaf.bold;
    const prev = out[out.length - 1];
    if (prev && prev.bold === bold) prev.text += leaf.text;
    else out.push({ text: leaf.text, bold });
  }
  return out;
}

function typeText(editor: Editor, text: string): void {
  if (editor.children.length === 0) {
    editor.children = [{ type: "paragraph", children: [{ text: "" }] } as never];
  }
  if (!editor.selection) {
    Transforms.select(editor, Editor.end(editor, [0]));
  }
  Transforms.insertText(editor, text);
}

describe("plexus-text-plate — thin alias over slate membrane", () => {
  it("typing in peer A's editor reaches peer B's editor", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindPlate(edA, textA, docA);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindPlate(edB, textB, docB);

    typeText(edA, "hello");
    expect(toText(textA)).to.equal("hello");

    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    expect(toText(textB)).to.equal("hello");
    expect(editorText(edB)).to.equal("hello");

    unbindA();
    unbindB();
  });

  it("a model mark projects into a Slate leaf mark via bindPlate", () => {
    const { doc, root: text } = makeText();
    const ed = makeEditor();
    const unbind = bindPlate(ed, text, doc);

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
    const unbindA = bindPlate(edA, textA, docA);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindPlate(edB, textB, docB);

    typeText(edA, "AAA");
    typeText(edB, "BBB");
    expect(toText(textA)).to.equal("AAA");
    expect(toText(textB)).to.equal("BBB");

    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    const merged = toText(textA);
    expect(merged.length).to.equal(6);
    expect(toText(textB)).to.equal(merged);
    expect(editorText(edA)).to.equal(merged);
    expect(editorText(edB)).to.equal(merged);

    unbindA();
    unbindB();
  });

  it("remote insert uses range ops — not full children replace of the paragraph", () => {
    const { doc: docA, root: textA } = makeText();
    const edA = makeEditor();
    const unbindA = bindPlate(edA, textA, docA);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindPlate(edB, textB, docB);

    insertTextAt(textA, 0, "ab");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    expect(editorText(edB)).to.equal("ab");

    const ops: Operation[] = [];
    const origApply = edB.apply.bind(edB);
    edB.apply = (op: Operation) => {
      ops.push(op);
      return origApply(op);
    };

    insertTextAt(textA, 1, "X");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    expect(toText(textB)).to.equal("aXb");
    expect(editorText(edB)).to.equal("aXb");

    const nukedParagraph = ops.some(
      (op) =>
        (op.type === "remove_node" && op.path.length === 1 && op.path[0] === 0) ||
        (op.type === "insert_node" && op.path.length === 1 && op.path[0] === 0),
    );
    expect(nukedParagraph).to.equal(false);

    const hasRangeTextOp = ops.some((op) => op.type === "insert_text" || op.type === "remove_text");
    expect(hasRangeTextOp).to.equal(true);

    unbindA();
    unbindB();
  });

  it("createPlateBoundEditor returns a history-capable Slate editor", () => {
    const ed = createPlateBoundEditor();
    expect(ed).to.be.ok;
    expect((ed as { history?: unknown }).history).to.be.ok;
  });
});
