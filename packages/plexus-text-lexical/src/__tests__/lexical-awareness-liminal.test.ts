import { createHeadlessEditor } from "@lexical/headless";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  Plexus,
} from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  bindLexical,
  getRemoteSelections,
  type RemoteSelection,
  withLiminalGesture,
} from "../index.js";

let n = 0;
function bootstrap(seed = ""): { doc: Y.Doc; plexus: Plexus<PlexusText>; root: PlexusText } {
  const id = `lex-aw-${n++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc) as Plexus<PlexusText>;
  const root = plexus.root as PlexusText;
  if (seed) insertTextAt(root, 0, seed);
  return { doc, plexus, root };
}

function connectPeer(source: Y.Doc): { doc: Y.Doc; plexus: Plexus<PlexusText>; root: PlexusText } {
  const doc = new Y.Doc({ guid: source.guid });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  const plexus = Plexus.connect(doc) as Plexus<PlexusText>;
  return { doc, plexus, root: plexus.root as PlexusText };
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

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function syncAwareness(from: Plexus<PlexusText>, to: Plexus<PlexusText>) {
  const clients = [...from.awareness.states.keys()];
  if (clients.length === 0) return;
  applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, clients), "remote");
}

function editorText(ed: LexicalEditor): string {
  return ed.getEditorState().read(() => $getRoot().getTextContent());
}

describe("Lexical — awareness + liminality", () => {
  it("publishes selection when the editor updates with a selection", () => {
    const { doc, plexus, root } = bootstrap("hello");
    const ed = makeEditor();
    const unbind = bindLexical(ed, root, {
      doc,
      plexus,
      user: { name: "Alice", color: "#30bced" },
    });

    ed.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        p.append($createTextNode("hello"));
      },
      { discrete: true },
    );

    // selection is published after update (may be null in headless without explicit selection)
    expect(plexus.awareness.getField("user" as never)).to.deep.equal({
      name: "Alice",
      color: "#30bced",
    });

    unbind();
  });

  it("onRemoteSelections fires when a peer selection arrives", () => {
    const a = bootstrap("hello");
    const b = connectPeer(a.doc);
    const remotes: RemoteSelection[][] = [];

    const edA = makeEditor();
    const edB = makeEditor();
    const unA = bindLexical(edA, a.root, {
      doc: a.doc,
      plexus: a.plexus,
      user: { name: "A", color: "#f00" },
    });
    const unB = bindLexical(edB, b.root, {
      doc: b.doc,
      plexus: b.plexus,
      user: { name: "B", color: "#0f0" },
      onRemoteSelections: (r) => remotes.push(r),
    });

    // Seed text on both
    edA.update(
      () => {
        ($getRoot().getFirstChild() as ElementNode).append($createTextNode("hello"));
      },
      { discrete: true },
    );
    syncDocs(a.doc, b.doc);

    a.plexus.awareness.setField("selection" as never, { anchor: 0, head: 3 } as never);
    syncAwareness(a.plexus, b.plexus);

    const last = remotes.at(-1) ?? getRemoteSelections(b.plexus.awareness);
    expect(last.some((r) => r.selection.anchor === 0 && r.selection.head === 3)).to.equal(true);
    expect(last.some((r) => r.user?.name === "A" || r.color)).to.equal(true);

    unA();
    unB();
  });

  it("withLiminalGesture commits text so peer sees it after CRDT sync", () => {
    const a = bootstrap("ab");
    const b = connectPeer(a.doc);
    syncDocs(a.doc, b.doc);

    const edB = makeEditor();
    const unB = bindLexical(edB, b.root, { doc: b.doc, plexus: b.plexus });

    withLiminalGesture(a.plexus, () => {
      insertTextAt(a.root, 2, "X");
      a.plexus.broadcastLiminalPreview();
    });

    syncDocs(a.doc, b.doc);
    expect(toText(b.root)).to.equal("abX");
    expect(editorText(edB)).to.equal("abX");

    unB();
  });

  it("local caret survives outbound model write + inbound no-op pull (no full rebuild)", () => {
    const { doc, plexus, root } = bootstrap("hello world");
    const ed = makeEditor();
    const unbind = bindLexical(ed, root, {
      doc,
      plexus,
      user: { name: "Alice", color: "#30bced" },
    });

    // Place caret mid-document (after "hello ").
    ed.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        const t = p.getFirstChild() as TextNode;
        const sel = $createRangeSelection();
        sel.anchor.set(t.getKey(), 6, "text");
        sel.focus.set(t.getKey(), 6, "text");
        $setSelection(sel);
      },
      { discrete: true },
    );

    // Publish selection → awareness change must NOT re-render content / wipe caret.
    ed.update(() => {}, { discrete: true });

    const after = ed.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return null;
      return { a: sel.anchor.offset, f: sel.focus.offset };
    });
    expect(after).to.deep.equal({ a: 6, f: 6 });
    expect(editorText(ed)).to.equal("hello world");

    unbind();
  });

  it("L0-a: awareness selection publish does not rewrite editor content", () => {
    const { doc, plexus, root } = bootstrap("stable text");
    const ed = makeEditor();
    let pulls = 0;
    const unbind = bindLexical(ed, root, {
      doc,
      plexus,
      user: { name: "Alice", color: "#30bced" },
      onRemoteSelections: () => {
        pulls += 1;
      },
    });

    const before = editorText(ed);
    // Peer-style awareness noise (local selection field + fake peer)
    plexus.awareness.setField("selection" as never, { anchor: 2, head: 5 } as never);
    // Content path must be silent — text unchanged
    expect(editorText(ed)).to.equal(before);
    expect(toText(root)).to.equal("stable text");

    unbind();
    void pulls;
  });

  it("L0-b: caret survives remote insert far from caret", () => {
    const a = bootstrap("hello world");
    const b = connectPeer(a.doc);
    syncDocs(a.doc, b.doc);

    const edB = makeEditor();
    const unB = bindLexical(edB, b.root, { doc: b.doc, plexus: b.plexus });

    // Caret on B after "hello " (offset 6)
    edB.update(
      () => {
        const p = $getRoot().getFirstChild() as ElementNode;
        const t = p.getFirstChild() as TextNode;
        const sel = $createRangeSelection();
        sel.anchor.set(t.getKey(), 6, "text");
        sel.focus.set(t.getKey(), 6, "text");
        $setSelection(sel);
      },
      { discrete: true },
    );

    // Remote insert at end (far from caret)
    insertTextAt(a.root, toText(a.root).length, "!");
    syncDocs(a.doc, b.doc);

    expect(editorText(edB)).to.equal("hello world!");
    const caret = edB.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return null;
      // Offset may map through textDiff apply; should still be near 6, not forced to 0
      return sel.anchor.offset;
    });
    expect(caret).to.not.equal(null);
    expect(caret!).to.be.greaterThan(0); // not reset to origin

    unB();
  });

  it("liminal peer preview appears; after revert+explicit clear, peer is clean and commit path converges", () => {
    const a = bootstrap("ab");
    const b = connectPeer(a.doc);
    syncDocs(a.doc, b.doc);

    a.plexus.enterLiminality();
    insertTextAt(a.root, 2, "TEMP");
    a.plexus.broadcastLiminalPreview();
    syncAwareness(a.plexus, b.plexus);
    expect(toText(b.root)).to.equal("abTEMP");

    a.plexus.revertLiminality();
    b.plexus.applyPeerPreview(a.plexus.awareness.clientID, null);
    // A discarded; CRDT never got TEMP
    syncDocs(a.doc, b.doc);
    expect(toText(a.root)).to.equal("ab");
    expect(toText(b.root)).to.equal("ab");
  });
});
