import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { C, resetCounters, withCounterWindow } from "@here.build/plexus-text/bench";
import { createEditor, Editor, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindSlate } from "../index.js";

/**
 * P1 projector path: structured events apply 1-char remote without live toText.
 */

let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `slate-p1-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}

function makeEditor(): Editor {
  return withHistory(createEditor());
}

function editorText(editor: Editor): string {
  if (editor.children.length === 0) return "";
  return Editor.string(editor, [0]);
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

describe("plexus-text-slate — P1 projector", () => {
  it("1-char remote mid-insert applies without toText on the live path (C.on)", () => {
    const { doc: docA, root: textA } = makeText();
    insertTextAt(textA, 0, "hello");

    const edA = makeEditor();
    const unbindA = bindSlate(edA, textA, { doc: docA, projector: "p1" });
    expect(editorText(edA)).to.equal("hello");

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;

    const { delta } = withCounterWindow(() => {
      insertTextAt(textB, 2, "X");
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    });

    expect(toText(textA)).to.equal("heXllo");
    expect(editorText(edA)).to.equal("heXllo");
    // Seed already done; live remote path must not call toText when P1 applies.
    expect(delta.toText).to.equal(0);
    expect(delta.p1Resyncs).to.equal(0);
    expect(delta.p1Events).to.be.greaterThan(0);

    unbindA();
    resetCounters();
    C.on = false;
  });

  it("two live P1 bindings: remote edit converges", () => {
    const { doc: docA, root: textA } = makeText();
    insertTextAt(textA, 0, "hello");
    const edA = makeEditor();
    const unbindA = bindSlate(edA, textA, { doc: docA, projector: "p1" });

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindSlate(edB, textB, { doc: docB, projector: "p1" });

    typeText(edA, " world");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    expect(toText(textB)).to.equal("hello world");
    expect(editorText(edB)).to.equal("hello world");
    expect(editorText(edA)).to.equal("hello world");

    unbindA();
    unbindB();
  });

  it("projector auto still works (falls through to p1 when observe available)", () => {
    const { doc, root } = makeText();
    insertTextAt(root, 0, "ab");
    const ed = makeEditor();
    const unbind = bindSlate(ed, root, { doc, projector: "auto" });
    typeText(ed, "c");
    expect(toText(root)).to.equal("abc");
    expect(editorText(ed)).to.equal("abc");
    unbind();
  });

  it("projector p0 still uses toText on remote path", () => {
    const { doc: docA, root: textA } = makeText();
    insertTextAt(textA, 0, "hello");
    const edA = makeEditor();
    const unbindA = bindSlate(edA, textA, { doc: docA, projector: "p0" });

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;

    const { delta } = withCounterWindow(() => {
      insertTextAt(textB, 2, "X");
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    });

    expect(editorText(edA)).to.equal("heXllo");
    // P0 live path must call toText (reaction / pull).
    expect(delta.toText).to.be.greaterThan(0);

    unbindA();
    resetCounters();
    C.on = false;
  });
});
