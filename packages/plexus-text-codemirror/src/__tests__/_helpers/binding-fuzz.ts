import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText, segments, toText, type Segment } from "@here.build/plexus-text";
import * as prng from "lib0/prng";
import * as Y from "yjs";

import { applyCmChange, plexusTextSync } from "../../index.js";

/**
 * Layer C — binding fuzz harness (CodeMirror).
 *
 * Sync schedule (G1): each step apply one op through the editor; with p≈0.3
 * sync a random peer pair; full mesh before assert.
 */

export type Peer = {
  clientID: number;
  doc: Y.Doc;
  root: PlexusText;
  view: EditorView;
};

export type TracedOp =
  | { peer: number; op: "insertText"; args: { pos: number; text: string } }
  | { peer: number; op: "deleteRange"; args: { from: number; to: number } }
  | { peer: number; op: "replace"; args: { from: number; to: number; text: string } };

export type CanonicalDoc = {
  text: string;
  segments: Segment[];
  editorText: string;
};

export function normalize(peer: Peer): CanonicalDoc {
  return {
    text: toText(peer.root),
    segments: segments(peer.root),
    editorText: peer.view.state.doc.toString(),
  };
}

/** Bootstrap the first peer (owns the shared doc guid). */
export function createBootstrapPeer(clientID: number, seed = ""): Peer {
  const id = `cm-fuzz-${clientID}`;
  const doc = new Y.Doc({ guid: "cm-fuzz-shared" });
  doc.clientID = clientID;
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  const root = plexus.root as PlexusText;
  if (seed) insertTextAt(root, 0, seed);
  const view = new EditorView({
    doc: toText(root),
    extensions: [plexusTextSync(root, doc)],
    parent: document.createElement("div"),
  });
  return { clientID, doc, root, view };
}

/** Connect a peer to an existing bootstrap doc (same guid + state). */
export function clonePeer(source: Peer, clientID: number): Peer {
  const doc = new Y.Doc({ guid: source.doc.guid });
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc));
  const root = Plexus.connect(doc).root as PlexusText;
  const view = new EditorView({
    doc: toText(root),
    extensions: [plexusTextSync(root, doc)],
    parent: document.createElement("div"),
  });
  return { clientID, doc, root, view };
}

export function syncPair(a: Peer, b: Peer): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
}

export function fullMesh(peers: Peer[]): void {
  for (let i = 0; i < peers.length; i++) {
    for (let j = 0; j < peers.length; j++) {
      if (i === j) continue;
      Y.applyUpdate(peers[j].doc, Y.encodeStateAsUpdate(peers[i].doc, Y.encodeStateVector(peers[j].doc)));
    }
  }
}

function applyThroughEditor(peer: Peer, op: TracedOp): void {
  const len = peer.view.state.doc.length;
  switch (op.op) {
    case "insertText": {
      const pos = len === 0 ? 0 : op.args.pos % (len + 1);
      peer.view.dispatch({ changes: { from: pos, to: pos, insert: op.args.text } });
      break;
    }
    case "deleteRange": {
      if (len === 0) return;
      const a = op.args.from % (len + 1);
      const b = op.args.to % (len + 1);
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      if (to > from) peer.view.dispatch({ changes: { from, to, insert: "" } });
      break;
    }
    case "replace": {
      if (len === 0) {
        peer.view.dispatch({ changes: { from: 0, to: 0, insert: op.args.text } });
        return;
      }
      const a = op.args.from % (len + 1);
      const b = op.args.to % (len + 1);
      peer.view.dispatch({
        changes: { from: Math.min(a, b), to: Math.max(a, b), insert: op.args.text },
      });
      break;
    }
  }
}

function randomOp(gen: prng.PRNG, peer: number): TracedOp {
  const kind = prng.int32(gen, 0, 3);
  const pos = prng.int32(gen, 0, 40);
  const word = prng.word(gen, 1, 4);
  if (kind === 0) return { peer, op: "insertText", args: { pos, text: word } };
  if (kind === 1) return { peer, op: "deleteRange", args: { from: pos, to: pos + prng.int32(gen, 0, 5) } };
  return { peer, op: "replace", args: { from: pos, to: pos + prng.int32(gen, 0, 4), text: word } };
}

/**
 * Run binding fuzz. Returns trace for replay on failure.
 * Postcondition: all peers agree on normalize() after full mesh.
 */
export function applyRandomBindingTests(opts: {
  peers: number;
  steps: number;
  seed: number;
}): { peers: Peer[]; trace: TracedOp[] } {
  const gen = prng.create(opts.seed);
  const peers: Peer[] = [createBootstrapPeer(1, "hi")];
  for (let i = 1; i < opts.peers; i++) peers.push(clonePeer(peers[0], i + 1));
  const trace: TracedOp[] = [];
  for (let s = 0; s < opts.steps; s++) {
    // lib0 prng.int32 upper bound is inclusive
    const pi = prng.int32(gen, 0, opts.peers - 1);
    const op = randomOp(gen, pi);
    trace.push(op);
    try {
      applyThroughEditor(peers[pi], op);
    } catch {
      // schema-invalid / out-of-range — skip
    }
    if (prng.int32(gen, 0, 99) < 30) {
      const a = prng.int32(gen, 0, opts.peers - 1);
      let b = prng.int32(gen, 0, opts.peers - 1);
      if (b === a) b = (b + 1) % opts.peers;
      syncPair(peers[a], peers[b]);
    }
  }
  fullMesh(peers);
  return { peers, trace };
}

export function assertPeersAgree(peers: Peer[], label: string): void {
  const base = normalize(peers[0]);
  for (let i = 1; i < peers.length; i++) {
    const other = normalize(peers[i]);
    if (JSON.stringify(other) !== JSON.stringify(base)) {
      throw new Error(
        `${label}: peer 0 vs ${i} diverged\n` +
          `0: ${JSON.stringify(base)}\n` +
          `${i}: ${JSON.stringify(other)}`,
      );
    }
  }
  // model text === editor text on each peer
  for (const p of peers) {
    const n = normalize(p);
    if (n.text !== n.editorText) {
      throw new Error(`${label}: peer ${p.clientID} model/editor split: model=${JSON.stringify(n.text)} editor=${JSON.stringify(n.editorText)}`);
    }
  }
}

// silence unused import if tree-shaken weirdly
void applyCmChange;
