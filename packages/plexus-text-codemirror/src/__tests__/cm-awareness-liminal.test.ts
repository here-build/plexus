import { EditorView } from "@codemirror/view";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  Plexus,
} from "@here.build/plexus";
import { insertTextAt, PlexusText, toText } from "@here.build/plexus-text";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyCmChange, plexusTextSync, withLiminalGesture } from "../index.js";

let n = 0;
function bootstrap(seed = ""): { doc: Y.Doc; plexus: Plexus<PlexusText>; root: PlexusText } {
  const id = `cm-aw-${n++}`;
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

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function syncAwareness(from: Plexus<PlexusText>, to: Plexus<PlexusText>) {
  const clients = [...from.awareness.states.keys()];
  if (clients.length === 0) return;
  applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, clients), "remote");
}

describe("CodeMirror — awareness + liminality", () => {
  it("publishes local selection to awareness on selection change", () => {
    const { doc, plexus, root } = bootstrap("hello");
    const view = new EditorView({
      doc: "hello",
      extensions: [
        plexusTextSync(root, {
          doc,
          plexus,
          user: { name: "Alice", color: "#30bced" },
        }),
      ],
      parent: document.createElement("div"),
    });

    view.dispatch({ selection: { anchor: 1, head: 4 } });

    const sel = plexus.awareness.getField("selection" as never) as { anchor: number; head: number } | null;
    expect(sel).to.deep.equal({ anchor: 1, head: 4 });
    expect(plexus.awareness.getField("user" as never)).to.deep.equal({ name: "Alice", color: "#30bced" });

    view.destroy();
  });

  it("remote peer selection is readable after awareness sync", () => {
    const a = bootstrap("hello");
    const b = connectPeer(a.doc);

    const viewA = new EditorView({
      doc: "hello",
      extensions: [plexusTextSync(a.root, { doc: a.doc, plexus: a.plexus, user: { name: "A", color: "#f00" } })],
      parent: document.createElement("div"),
    });
    const viewB = new EditorView({
      doc: "hello",
      extensions: [plexusTextSync(b.root, { doc: b.doc, plexus: b.plexus, user: { name: "B", color: "#0f0" } })],
      parent: document.createElement("div"),
    });

    viewA.dispatch({ selection: { anchor: 0, head: 2 } });
    syncAwareness(a.plexus, b.plexus);

    const peerIds = b.plexus.awareness.getPeerIds().filter((id) => id !== b.plexus.awareness.doc.clientID);
    // A's base client id should appear among B's peers
    expect(peerIds.length).to.be.greaterThan(0);
    let found: { anchor: number; head: number } | undefined;
    for (const id of b.plexus.awareness.getPeerIds()) {
      const peer = b.plexus.awareness.getPeer(id) as {
        selection?: { anchor: number; head: number };
        user?: { name: string };
      } | null;
      if (peer?.selection) found = peer.selection;
      if (peer?.user?.name === "A") {
        expect(peer.selection).to.deep.equal({ anchor: 0, head: 2 });
      }
    }
    expect(found).to.deep.equal({ anchor: 0, head: 2 });

    viewA.destroy();
    viewB.destroy();
  });

  it("withLiminalGesture commits text so peer sees it after CRDT sync", () => {
    const a = bootstrap("ab");
    const b = connectPeer(a.doc);
    syncDocs(a.doc, b.doc);

    const viewB = new EditorView({
      doc: toText(b.root),
      extensions: [plexusTextSync(b.root, { doc: b.doc, plexus: b.plexus })],
      parent: document.createElement("div"),
    });

    withLiminalGesture(a.plexus, () => {
      insertTextAt(a.root, 2, "X");
      expect(toText(a.root)).to.equal("abX");
      a.plexus.broadcastLiminalPreview();
    });

    syncDocs(a.doc, b.doc);
    expect(toText(b.root)).to.equal("abX");
    expect(viewB.state.doc.toString()).to.equal("abX");

    viewB.destroy();
  });

  it("liminal peer preview appears on B during session; commit lands permanently", () => {
    const a = bootstrap("ab");
    const b = connectPeer(a.doc);
    syncDocs(a.doc, b.doc);
    expect(toText(b.root)).to.equal("ab");

    a.plexus.enterLiminality();
    insertTextAt(a.root, 2, "TEMP");
    a.plexus.broadcastLiminalPreview();
    syncAwareness(a.plexus, b.plexus);
    // peer preview applied on B (Plexus auto-applies on awareness change)
    expect(toText(b.root)).to.equal("abTEMP");

    a.plexus.commitLiminality();
    // Drop the ephemeral preview on B, then apply the committed CRDT delta.
    // (Entity-list undos via peer-preview UM can leave residue if we only rely on
    // awareness clear — explicit applyPeerPreview(null) is the binding contract.)
    b.plexus.applyPeerPreview(a.plexus.awareness.clientID, null);
    syncDocs(a.doc, b.doc);
    expect(toText(b.root)).to.equal("abTEMP");
  });

  it("legacy bare-doc API still two-way syncs", () => {
    const { doc, root } = bootstrap("hi");
    const view = new EditorView({
      doc: "hi",
      extensions: [plexusTextSync(root, doc)],
      parent: document.createElement("div"),
    });
    applyCmChange(root, 2, 2, "!");
    // pull via a real peer update
    const peer = connectPeer(doc);
    insertTextAt(peer.root, 0, "x");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(doc)));
    expect(view.state.doc.toString()).to.include("x");
    view.destroy();
  });
});
