import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { C, resetCounters, withCounterWindow } from "@here.build/plexus-text/bench";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { plexusTextSync } from "../index.js";

/**
 * P1 projector path: structured events apply 1-char remote without live toText.
 */

let n = 0;
function makeText(): { doc: Y.Doc; root: PlexusText } {
  const id = `cm-p1-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  return { doc, root: plexus.root as PlexusText };
}

describe("plexus-text-codemirror — P1 projector", () => {
  it("1-char remote mid-insert applies without toText on the live path (C.on)", () => {
    const { doc: docA, root: textA } = makeText();
    insertTextAt(textA, 0, "hello");

    const viewA = new EditorView({
      doc: "hello",
      extensions: [plexusTextSync(textA, { doc: docA, projector: "p1" })],
      parent: document.createElement("div"),
    });
    expect(viewA.state.doc.toString()).to.equal("hello");

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;

    const { delta } = withCounterWindow(() => {
      insertTextAt(textB, 2, "X");
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    });

    expect(toText(textA)).to.equal("heXllo");
    expect(viewA.state.doc.toString()).to.equal("heXllo");
    // Seed already done; live remote path must not call toText when P1 applies.
    expect(delta.toText).to.equal(0);
    expect(delta.p1Resyncs).to.equal(0);
    expect(delta.p1Events).to.be.greaterThan(0);

    viewA.destroy();
    resetCounters();
    C.on = false;
  });

  it("two live P1 bindings: remote edit converges", () => {
    const { doc: docA, root: textA } = makeText();
    insertTextAt(textA, 0, "hello");
    const viewA = new EditorView({
      doc: "hello",
      extensions: [plexusTextSync(textA, { doc: docA, projector: "p1" })],
      parent: document.createElement("div"),
    });

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = Plexus.connect(docB).root as PlexusText;
    const viewB = new EditorView({
      doc: toText(textB),
      extensions: [plexusTextSync(textB, { doc: docB, projector: "p1" })],
      parent: document.createElement("div"),
    });

    viewA.dispatch({ changes: { from: 5, insert: " world" } });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    expect(toText(textB)).to.equal("hello world");
    expect(viewB.state.doc.toString()).to.equal("hello world");
    expect(viewA.state.doc.toString()).to.equal("hello world");

    viewA.destroy();
    viewB.destroy();
  });

  it("projector auto still works (falls through to p1 when observe available)", () => {
    const { doc, root } = makeText();
    insertTextAt(root, 0, "ab");
    const view = new EditorView({
      doc: "ab",
      extensions: [plexusTextSync(root, { doc, projector: "auto" })],
      parent: document.createElement("div"),
    });
    view.dispatch({ changes: { from: 2, insert: "c" } });
    expect(toText(root)).to.equal("abc");
    expect(view.state.doc.toString()).to.equal("abc");
    view.destroy();
  });
});
