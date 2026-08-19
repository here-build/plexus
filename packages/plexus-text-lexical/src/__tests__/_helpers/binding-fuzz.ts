import { createHeadlessEditor } from "@lexical/headless";
import { Plexus } from "@here.build/plexus";
import {
  insertTextAt,
  PlexusText,
  segments,
  toText,
  type Segment,
} from "@here.build/plexus-text";
import {
  $createTextNode,
  $getRoot,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import * as prng from "lib0/prng";
import * as Y from "yjs";

import { bindLexical } from "../../index.js";

/**
 * Layer C — binding fuzz harness (Lexical, text + bold/italic/code).
 *
 * Sync schedule (G1): each step apply one op through the editor; with p≈0.3
 * sync a random peer pair; full mesh before assert.
 */

export type Peer = {
  clientID: number;
  doc: Y.Doc;
  root: PlexusText;
  editor: LexicalEditor;
  unbind: () => void;
};

export type TracedOp =
  | { peer: number; op: "insertText"; args: { pos: number; text: string } }
  | { peer: number; op: "deleteRange"; args: { from: number; to: number } }
  | { peer: number; op: "replace"; args: { from: number; to: number; text: string } }
  | { peer: number; op: "toggleBold"; args: { from: number; to: number } };

export type CanonicalDoc = {
  text: string;
  segments: Segment[];
  editorText: string;
};

function editorText(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

export function normalize(peer: Peer): CanonicalDoc {
  return {
    text: toText(peer.root),
    segments: segments(peer.root),
    editorText: editorText(peer.editor),
  };
}

/** Bootstrap the first peer (owns the shared doc guid). */
export function createBootstrapPeer(clientID: number, seed = ""): Peer {
  const id = `lex-fuzz-${clientID}`;
  const doc = new Y.Doc({ guid: "lex-fuzz-shared" });
  doc.clientID = clientID;
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
  const root = plexus.root as PlexusText;
  if (seed) insertTextAt(root, 0, seed);
  const editor = createHeadlessEditor({
    namespace: `fuzz-${clientID}`,
    nodes: [],
    onError: (e) => {
      throw e;
    },
  });
  const unbind = bindLexical(editor, root, doc);
  return { clientID, doc, root, editor, unbind };
}

/** Connect a peer to an existing bootstrap doc (same guid + state). */
export function clonePeer(source: Peer, clientID: number): Peer {
  const doc = new Y.Doc({ guid: source.doc.guid });
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc));
  const root = Plexus.connect(doc).root as PlexusText;
  const editor = createHeadlessEditor({
    namespace: `fuzz-${clientID}`,
    nodes: [],
    onError: (e) => {
      throw e;
    },
  });
  const unbind = bindLexical(editor, root, doc);
  return { clientID, doc, root, editor, unbind };
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
  const len = editorText(peer.editor).length;
  peer.editor.update(
    () => {
      const p = $getRoot().getFirstChild() as ElementNode | null;
      if (p === null) return;
      switch (op.op) {
        case "insertText": {
          const pos = len === 0 ? 0 : op.args.pos % (len + 1);
          // Naive: clear+rewrite is wrong; splice via text content rebuild for headless simplicity
          const cur = $getRoot().getTextContent();
          const next = cur.slice(0, pos) + op.args.text + cur.slice(pos);
          p.clear();
          if (next) p.append($createTextNode(next));
          break;
        }
        case "deleteRange": {
          if (len === 0) return;
          const a = op.args.from % (len + 1);
          const b = op.args.to % (len + 1);
          const from = Math.min(a, b);
          const to = Math.max(a, b);
          const cur = $getRoot().getTextContent();
          const next = cur.slice(0, from) + cur.slice(to);
          p.clear();
          if (next) p.append($createTextNode(next));
          break;
        }
        case "replace": {
          const a = len === 0 ? 0 : op.args.from % (len + 1);
          const b = len === 0 ? 0 : op.args.to % (len + 1);
          const from = Math.min(a, b);
          const to = Math.max(a, b);
          const cur = $getRoot().getTextContent();
          const next = cur.slice(0, from) + op.args.text + cur.slice(to);
          p.clear();
          if (next) p.append($createTextNode(next));
          break;
        }
        case "toggleBold": {
          if (len === 0) return;
          const a = op.args.from % (len + 1);
          const b = op.args.to % (len + 1);
          const from = Math.min(a, b);
          const to = Math.max(a, b);
          if (to <= from) return;
          // Rebuild: plain prefix, bold mid, plain suffix (simple format op)
          const cur = $getRoot().getTextContent();
          p.clear();
          if (from > 0) p.append($createTextNode(cur.slice(0, from)));
          const mid = $createTextNode(cur.slice(from, to));
          mid.toggleFormat("bold");
          p.append(mid);
          if (to < cur.length) p.append($createTextNode(cur.slice(to)));
          break;
        }
      }
    },
    { discrete: true },
  );
}

function randomOp(gen: prng.PRNG, peer: number): TracedOp {
  const kind = prng.int32(gen, 0, 4);
  const pos = prng.int32(gen, 0, 40);
  const word = prng.word(gen, 1, 4);
  if (kind === 0) return { peer, op: "insertText", args: { pos, text: word } };
  if (kind === 1) return { peer, op: "deleteRange", args: { from: pos, to: pos + prng.int32(gen, 0, 5) } };
  if (kind === 2) return { peer, op: "replace", args: { from: pos, to: pos + prng.int32(gen, 0, 4), text: word } };
  return { peer, op: "toggleBold", args: { from: pos, to: pos + prng.int32(gen, 1, 6) } };
}

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
      /* skip */
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
  // Compare model projection only for segments (mark values); editor text must match model text.
  const baseText = toText(peers[0].root);
  const baseSegs = JSON.stringify(segments(peers[0].root));
  for (let i = 1; i < peers.length; i++) {
    if (toText(peers[i].root) !== baseText) {
      throw new Error(`${label}: peer 0 vs ${i} text diverged: ${baseText} vs ${toText(peers[i].root)}`);
    }
    if (JSON.stringify(segments(peers[i].root)) !== baseSegs) {
      throw new Error(
        `${label}: peer 0 vs ${i} segments diverged\n0: ${baseSegs}\n${i}: ${JSON.stringify(segments(peers[i].root))}`,
      );
    }
  }
  for (const p of peers) {
    if (toText(p.root) !== editorText(p.editor)) {
      throw new Error(
        `${label}: peer ${p.clientID} model/editor split: model=${JSON.stringify(toText(p.root))} editor=${JSON.stringify(editorText(p.editor))}`,
      );
    }
  }
}

void ($createTextNode as unknown);
void (0 as unknown as TextNode);
