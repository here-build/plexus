import { Plexus } from "@here.build/plexus";
import * as Y from "yjs";

import { addMark, insertTextAt, toText } from "../marker.js";
import { PlexusText, isMarker, isTextAtom } from "../PlexusText.js";
import type { ModelCounters } from "./counters.js";
import { withCounterWindow } from "./counters.js";

export type SizeReport = {
  N_chars: number;
  N_atoms: number;
  N_markers: number;
  N_nodes: number;
  N_entities: number;
  bytes_state: number;
  seed_ms: number;
  seed_delta: Readonly<Omit<ModelCounters, "on">>;
};

export type BenchPeer = {
  doc: Y.Doc;
  plexus: Plexus<PlexusText>;
  root: PlexusText;
  size: SizeReport;
};

let peerSeq = 0;

function lorem(n: number): string {
  const unit = "lorem ipsum dolor sit amet ";
  if (n <= 0) return "";
  const reps = Math.ceil(n / unit.length);
  return unit.repeat(reps).slice(0, n);
}

function sizeOf(root: PlexusText, doc: Y.Doc, seed_ms: number, seed_delta: Readonly<Omit<ModelCounters, "on">>): SizeReport {
  let N_atoms = 0;
  let N_markers = 0;
  for (const n of root.nodes) {
    if (isTextAtom(n)) N_atoms++;
    else if (isMarker(n)) N_markers++;
  }
  const N_chars = toText(root).length;
  const N_nodes = root.nodes.length;
  const N_entities = N_nodes + root.marks.size + 1;
  return {
    N_chars,
    N_atoms,
    N_markers,
    N_nodes,
    N_entities,
    bytes_state: Y.encodeStateAsUpdate(doc).byteLength,
    seed_ms,
    seed_delta,
  };
}

/** Bootstrap a peer with `N` plain characters via insertTextAt. */
export function plain(N: number): BenchPeer {
  const id = `bench-plain-${peerSeq++}`;
  const doc = new Y.Doc({ guid: id });
  const plexus = Plexus.bootstrap(new PlexusText({}), id, doc) as Plexus<PlexusText>;
  const root = plexus.root as PlexusText;

  const t0 = performance.now();
  const { delta } = withCounterWindow(() => {
    insertTextAt(root, 0, lorem(N));
  });
  const seed_ms = performance.now() - t0;

  return { doc, plexus, root, size: sizeOf(root, doc, seed_ms, delta) };
}

/** plain + one bold span every `every` chars. */
export function marked(N: number, every = 100): BenchPeer {
  const peer = plain(N);
  const t0 = performance.now();
  const { delta } = withCounterWindow(() => {
    for (let i = 0; i + 20 <= N; i += every) {
      addMark(peer.root, i, i + 20, "bold", true);
    }
  });
  const seed_ms = peer.size.seed_ms + (performance.now() - t0);
  const merged = { ...peer.size.seed_delta };
  for (const [k, v] of Object.entries(delta)) {
    (merged as Record<string, number>)[k] = ((merged as Record<string, number>)[k] ?? 0) + (v as number);
  }
  peer.size = sizeOf(peer.root, peer.doc, seed_ms, merged);
  return peer;
}

export function connectPeer(source: Y.Doc): { doc: Y.Doc; plexus: Plexus<PlexusText>; root: PlexusText } {
  const doc = new Y.Doc({ guid: source.guid });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  const plexus = Plexus.connect(doc) as Plexus<PlexusText>;
  return { doc, plexus, root: plexus.root as PlexusText };
}

export function syncAtoB(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

export { withCounterWindow, lorem };
export { C, snapshotCounters } from "./counters.js";
