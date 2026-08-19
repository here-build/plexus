import { createHeadlessEditor } from "@lexical/headless";
import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { C, resetCounters, withCounterWindow } from "@here.build/plexus-text/bench";
import { $createTextNode, $getRoot, type ElementNode, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindLexical } from "../index.js";

/**
 * P1 projector path: structured events apply 1-char remote without live toText.
 */

let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `lex-p1-${n++}`;
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

describe("plexus-text-lexical — P1 projector", () => {
  it("1-char remote mid-insert applies without toText on the live path (C.on)", () => {
    const { doc: docA, root: textA } = makeText();
    insertTextAt(textA, 0, "hello");

    const edA = makeEditor();
    const unbindA = bindLexical(edA, textA, { doc: docA, projector: "p1" });
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
    const unbindA = bindLexical(edA, textA, { doc: docA, projector: "p1" });

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const edB = makeEditor();
    const unbindB = bindLexical(edB, textB, { doc: docB, projector: "p1" });

    edA.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        p.append($createTextNode(" world"));
      },
      { discrete: true },
    );
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
    const unbind = bindLexical(ed, root, { doc, projector: "auto" });
    ed.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        p.append($createTextNode("c"));
      },
      { discrete: true },
    );
    expect(toText(root)).to.equal("abc");
    expect(editorText(ed)).to.equal("abc");
    unbind();
  });
});
