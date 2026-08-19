import * as prng from "lib0/prng";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { addMark, deleteTextRange, insertTextAt, segments, toText } from "../marker.js";
import { PlexusText } from "../PlexusText.js";
import { connectTestPlexus, initTestPlexus } from "./_helpers/test-plexus.js";

/**
 * SEC smoke test — adapted from yjs's `applyRandomTests`: N real Y.Docs on a simulated
 * network with message reordering + partition, random ops, then heal-and-assert.
 *
 * SCOPE — read this before trusting it: this proves only that **peers AGREE** after
 * healing (i.e. our marker layer doesn't break yjs's inherited Strong Eventual
 * Consistency) and that merging the raw update log equals live sync. It does NOT prove
 * the converged result is *correct* — cross-peer agreement passes even when every peer
 * converges to the same corrupted state (the naive split duplicates/loses text
 * convergently). Correctness vs a ground-truth sequential run is the job of
 * `plexustext-differential.test.ts` — that is the real convergence gate; this is a
 * cheap "didn't break SEC" check.
 */

const ALPHABET = "abcdefABCDEF ".split("");
const MARKS: string[] = ["bold", "italic", "code"];

interface Peer {
  doc: Y.Doc;
  root: PlexusText;
}

function randomOp(gen: prng.PRNG, text: PlexusText): void {
  const len = toText(text).length;
  const roll = prng.int32(gen, 0, 99);
  if (len === 0 || roll < 50) {
    const at = prng.int32(gen, 0, len);
    let s = "";
    for (let i = 0; i < prng.int32(gen, 1, 4); i++) s += prng.oneOf(gen, ALPHABET);
    insertTextAt(text, at, s);
  } else if (roll < 80) {
    const at = prng.int32(gen, 0, len - 1);
    deleteTextRange(text, at, at + prng.int32(gen, 1, Math.min(4, len - at)));
  } else {
    const a = prng.int32(gen, 0, len - 1);
    addMark(text, a, a + prng.int32(gen, 1, len - a), prng.oneOf(gen, MARKS));
  }
}

const NET = Symbol("network-delivery");

/** A simulated network: per-peer inboxes (reorderable), partition via online flags, and
 *  a full-state heal that guarantees eventual delivery (the SEC premise). */
class Network {
  readonly peers: Peer[] = [];
  private readonly inbox: Uint8Array[][];
  private readonly online: boolean[];
  readonly log: Uint8Array[] = [];

  constructor(count: number) {
    const { doc: doc0, root: root0 } = initTestPlexus<PlexusText>(new PlexusText({}));
    this.peers.push({ doc: doc0, root: root0 });
    for (let i = 1; i < count; i++) {
      const doc = new Y.Doc({ guid: doc0.guid });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(doc0));
      this.peers.push({ doc, root: connectTestPlexus<PlexusText>(doc).root });
    }
    this.inbox = this.peers.map(() => []);
    this.online = this.peers.map(() => true);
    this.peers.forEach((p, i) => {
      p.doc.on("update", (update: Uint8Array, origin: unknown) => {
        this.log.push(update);
        if (origin === NET) return; // a delivered message — don't echo it back out
        for (let j = 0; j < this.peers.length; j++) if (j !== i && this.online[j]) this.inbox[j].push(update);
      });
    });
    // Seed the log with the bootstrap state (the root-creation update predates the
    // listeners above) so `mergeUpdates(log)` can reconstruct a connectable doc.
    this.log.push(Y.encodeStateAsUpdate(this.peers[0].doc));
  }

  step(gen: prng.PRNG): void {
    const r = prng.int32(gen, 0, 99);
    if (r < 2) {
      const i = prng.int32(gen, 0, this.peers.length - 1);
      this.online[i] = !this.online[i]; // (dis|re)connect one peer
    } else if (r < 3) this.flushReady();
    else if (r < 53) this.deliverRandom(gen);
    randomOp(gen, this.peers[prng.int32(gen, 0, this.peers.length - 1)].root);
  }

  private deliverRandom(gen: prng.PRNG): void {
    const ready = this.peers.map((_, i) => i).filter((i) => this.online[i] && this.inbox[i].length > 0);
    if (ready.length === 0) return;
    const i = prng.oneOf(gen, ready);
    const [msg] = this.inbox[i].splice(prng.int32(gen, 0, this.inbox[i].length - 1), 1);
    Y.applyUpdate(this.peers[i].doc, msg, NET);
  }

  private flushReady(): void {
    for (let i = 0; i < this.peers.length; i++) {
      if (!this.online[i]) continue;
      for (const msg of this.inbox[i].splice(0)) Y.applyUpdate(this.peers[i].doc, msg, NET);
    }
  }

  /** Eventual delivery: reconnect everyone, then full state-vector diff to a fixpoint. */
  heal(): void {
    for (let i = 0; i < this.online.length; i++) this.online[i] = true;
    for (let round = 0; round < this.peers.length + 2; round++) {
      let changed = false;
      for (const a of this.peers)
        for (const b of this.peers) {
          if (a === b) continue;
          const before = Y.encodeStateVector(b.doc);
          Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), NET);
          if (!eqBytes(before, Y.encodeStateVector(b.doc))) changed = true;
        }
      if (!changed) break;
    }
  }
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** All peers agree (the SEC property). NOT a correctness check — see the file header. */
function assertPeersAgree(net: Network): void {
  const text0 = toText(net.peers[0].root);
  const seg0 = segments(net.peers[0].root);
  for (let i = 1; i < net.peers.length; i++) {
    expect(toText(net.peers[i].root), `peer ${i} toText agrees with peer 0`).to.equal(text0);
    expect(segments(net.peers[i].root), `peer ${i} segments agree with peer 0`).to.deep.equal(seg0);
  }
}

describe("PlexusText SEC smoke test (peers agree under reorder/partition — NOT correctness)", () => {
  it("idempotence — applying the same update twice is a no-op", () => {
    const { doc, root } = initTestPlexus<PlexusText>(new PlexusText({}));
    insertTextAt(root, 0, "hello");
    addMark(root, 0, 5, "bold");
    const update = Y.encodeStateAsUpdate(doc);
    const target = new Y.Doc({ guid: doc.guid });
    Y.applyUpdate(target, update);
    Y.applyUpdate(target, update);
    const tRoot = connectTestPlexus<PlexusText>(target).root;
    expect(toText(tRoot)).to.equal("hello");
    expect(segments(tRoot)).to.deep.equal(segments(root));
  });

  it(
    "5 peers × 500 steps × reorder+partition, pinned seeds — peers converge, merge==live-sync",
    () => {
    for (const seed of [1, 7, 42, 1337, 90210, 555, 8888]) {
      const gen = prng.create(seed);
      const net = new Network(5);
      insertTextAt(net.peers[0].root, 0, "seed text here");
      net.heal();

      for (let step = 0; step < 500; step++) {
        net.step(gen);
        if (step % 100 === 99) {
          net.heal();
          assertPeersAgree(net);
        }
      }
      net.heal();
      assertPeersAgree(net);

      // merge(log) must reconstruct the same rendered state as live sync.
      const merged = new Y.Doc({ guid: net.peers[0].doc.guid });
      Y.applyUpdate(merged, Y.mergeUpdates(net.log), NET);
      const mergedRoot = connectTestPlexus<PlexusText>(merged).root;
      expect(segments(mergedRoot), `seed ${seed}: merge(log) == live-sync`).to.deep.equal(segments(net.peers[0].root));
    }
  },
    30_000,
  );
});
