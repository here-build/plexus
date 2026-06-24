import { createHash } from "node:crypto";

import { reaction } from "mobx";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusTypedArrayAliasError } from "../../errors.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// Test-domain rule inversions: `Array.from(proxy)`/`[...proxy]` assert byte
// contents; `.sort()` exercises the proxy's mutating sort; sha1 proves the
// detached copy has real TypedArray slots (not a security context).
/* eslint-disable unicorn/prefer-spread, unicorn/no-array-sort, sonarjs/hashing */

beforeAll(() => {
  enableMobXIntegration();
});

@syncing("BlobHolder")
class BlobHolder extends PlexusModel {
  // Plain `@syncing accessor content!: Uint8Array` — reads as the write-tracking
  // proxy (a real-ish Uint8Array), accepts a plain Uint8Array on write and at
  // construction. `.slice()` returns a detached copy for native consumers; no
  // bespoke type or `.declare<>()` needed.
  @syncing accessor content!: Uint8Array;

  @syncing accessor label!: string;
}

// Sync helper — mirrors 4-cross-document/sync.test.ts
function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  const update1 = Y.encodeStateAsUpdate(doc1);
  const update2 = Y.encodeStateAsUpdate(doc2);
  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
}

describe("Uint8Array val field", () => {
  it("round-trips bytes identically", () => {
    const holder = new BlobHolder({ content: new Uint8Array([0, 255, 128, 1]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    expect(Array.from(root.content)).to.deep.equal([0, 255, 128, 1]);
    expect(root.content.length).to.equal(4);
    expect(root.content[1]).to.equal(255);
  });

  it("clones on set — caller mutating the passed buffer cannot corrupt stored bytes", () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const holder = new BlobHolder({ content: buf, label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    buf[0] = 9; // mutate the buffer the caller passed in

    expect(root.content[0]).to.equal(1); // stored byte unchanged
    expect(Array.from(root.content)).to.deep.equal([1, 2, 3, 4]);
  });

  it("clones on set for a re-assignment too", () => {
    const holder = new BlobHolder({ content: new Uint8Array([0]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const buf = new Uint8Array([10, 20, 30]);
    root.content = buf;
    buf[2] = 99;

    expect(Array.from(root.content)).to.deep.equal([10, 20, 30]);
  });

  it("syncs a mutating method (fill) across two connected docs", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "a" });
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(holder);
    const docB = new Y.Doc({ guid: docA.guid });

    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    rootA.content.fill(7);
    syncDocs(docA, docB);

    expect(Array.from(rootB.content)).to.deep.equal([7, 7, 7, 7]);
    // local side reflects the mutation immediately
    expect(Array.from(rootA.content)).to.deep.equal([7, 7, 7, 7]);
  });

  it("syncs an index write across two connected docs", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "a" });
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(holder);
    const docB = new Y.Doc({ guid: docA.guid });

    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    rootA.content[0] = 42;
    syncDocs(docA, docB);

    expect(rootB.content[0]).to.equal(42);
    expect(rootA.content[0]).to.equal(42);
  });

  it("slice() returns a REAL detached Uint8Array usable by node crypto (the detach hatch)", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const native = root.content.slice();
    expect(native).to.be.instanceOf(Uint8Array);
    // proves real indexed slots (the tracking proxy itself has none — crypto reads slots)
    const hash = createHash("sha1").update(native).digest("hex");
    expect(hash).to.equal(
      createHash("sha1")
        .update(new Uint8Array([1, 2, 3, 4]))
        .digest("hex"),
    );

    // detached: mutating the slice copy does not touch stored bytes
    native[0] = 99;
    expect(root.content[0]).to.equal(1);

    // a partial slice is also a real, detached copy
    const part = root.content.slice(1, 3);
    expect(Array.from(part)).to.deep.equal([2, 3]);
    part[0] = 0;
    expect(root.content[1]).to.equal(2);
  });

  it("is Proxy-invariant safe: Object.keys / spread / descriptors mirror a real Uint8Array", () => {
    const holder = new BlobHolder({ content: new Uint8Array([7, 8, 9]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    // These all route through ownKeys + getOwnPropertyDescriptor — a mismatched
    // non-configurable descriptor here would throw a TypeError (the classic
    // "real Uint8Array target trips Proxy invariants" trap).
    expect(Object.keys(root.content)).to.deep.equal(["0", "1", "2"]);
    expect({ ...root.content }).to.deep.equal({ "0": 7, "1": 8, "2": 9 });
    expect([...root.content]).to.deep.equal([7, 8, 9]);
    expect(Reflect.ownKeys(root.content)).to.deep.equal(["0", "1", "2"]);
    // length has no OWN descriptor on a Uint8Array (prototype getter)
    expect(Object.getOwnPropertyDescriptor(root.content, "length")).to.equal(undefined);
    expect(Object.getOwnPropertyDescriptor(root.content, "0")).to.deep.include({ value: 7, configurable: true });
  });

  it("is instanceof Uint8Array and copies correctly via Buffer.from / new Uint8Array", () => {
    const holder = new BlobHolder({ content: new Uint8Array([5, 6, 7]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    expect(root.content instanceof Uint8Array).to.equal(true);

    const fromBuffer = Buffer.from(root.content);
    expect(Array.from(fromBuffer)).to.deep.equal([5, 6, 7]);

    const fromCtor = new Uint8Array(root.content);
    expect(Array.from(fromCtor)).to.deep.equal([5, 6, 7]);
    // independent copy
    fromCtor[0] = 0;
    expect(root.content[0]).to.equal(5);
  });

  it("bans subarray and the buffer getter (aliasing escapes), but allows slice (a copy)", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    // slice copies → allowed (this is the detach hatch); subarray/.buffer alias → banned
    expect(() => root.content.slice(0, 1)).to.not.throw();

    // The door: a typed PlexusTypedArrayAliasError routing to .slice().
    expect(() => root.content.subarray(0, 1)).to.throw(PlexusTypedArrayAliasError);
    expect(() => (root.content as unknown as { buffer: ArrayBuffer }).buffer).to.throw(PlexusTypedArrayAliasError);
  });

  it("read-only methods (indexOf/includes/join) pass through without mutating", () => {
    const holder = new BlobHolder({ content: new Uint8Array([10, 20, 30]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    expect(root.content.indexOf(20)).to.equal(1);
    expect(root.content.includes(30)).to.equal(true);
    expect(root.content.join("-")).to.equal("10-20-30");
    // unchanged
    expect(Array.from(root.content)).to.deep.equal([10, 20, 30]);
  });

  it("mutating methods sort/reverse return the field proxy (chainable)", () => {
    const holder = new BlobHolder({ content: new Uint8Array([3, 1, 2]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const sorted = root.content.sort();
    expect(Array.from(root.content)).to.deep.equal([1, 2, 3]);
    expect(sorted instanceof Uint8Array).to.equal(true);

    root.content.reverse();
    expect(Array.from(root.content)).to.deep.equal([3, 2, 1]);
  });

  it("returns a stable reference for the same owner+key", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    expect(root.content).to.equal(root.content);
  });

  it("a MobX reaction on the field fires when bytes change (index write)", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const notify = vi.fn();
    const dispose = reaction(() => root.content[0], notify);

    expect(notify).not.toHaveBeenCalled();

    root.content[0] = 99;
    expect(notify).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("a MobX reaction observing iteration fires when a mutating method runs", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const notify = vi.fn();
    const dispose = reaction(() => Array.from(root.content).join(","), notify);

    root.content.fill(0);
    expect(notify).toHaveBeenCalledTimes(1);

    dispose();
  });

  // ── Negative flow: a byte change must NOT wake unrelated reactions ──────────

  it("NEGATIVE: a reaction on a sibling field does not fire when bytes change", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "start" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const notify = vi.fn();
    const dispose = reaction(() => root.label, notify);

    root.content.fill(9); // bulk byte change
    root.content[0] = 42; // index byte change
    expect(notify).not.toHaveBeenCalled();

    // sanity: the same reaction DOES fire on its own field
    root.label = "changed";
    expect(notify).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("NEGATIVE: a per-index reaction does not fire on an unrelated index write", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const notify = vi.fn();
    const dispose = reaction(() => root.content[0], notify);

    root.content[1] = 99; // a different index — content[0] reader must stay asleep
    expect(notify).not.toHaveBeenCalled();

    root.content[0] = 99; // the observed index — now it fires
    expect(notify).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("NEGATIVE: writing a byte to its current value does not fire", () => {
    const holder = new BlobHolder({ content: new Uint8Array([5, 6, 7]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const notify = vi.fn();
    const dispose = reaction(() => root.content[0], notify);

    root.content[0] = 5; // identical byte — no-op, must not fire
    expect(notify).not.toHaveBeenCalled();

    dispose();
  });

  it("a REMOTE byte change wakes a reaction (via the field-key tracker)", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "a" });
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(holder);
    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    // A per-index reader on doc B. Every proxy read also tracks owner+key (the
    // decorator getter), and B's model observer fires owner+key on a remote
    // change — so the reader wakes even though the remote path doesn't fire the
    // granular self+index tracker that LOCAL writes do.
    const notify = vi.fn();
    const dispose = reaction(() => rootB.content[0], notify);

    rootA.content[0] = 42; // local write on A
    syncDocs(docA, docB); // → remote change on B

    expect(rootB.content[0]).to.equal(42);
    expect(notify).toHaveBeenCalled();

    dispose();
  });

  it("NEGATIVE: a remote byte change does not wake a sibling-field reaction", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "start" });
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(holder);
    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    // Remote byte changes fire only owner+"content" (the field key), so a reader
    // of a SIBLING field stays asleep — remote reactivity is field-scoped.
    // (Per-INDEX isolation is local-only: remotely, owner+key wakes every content
    // reader coarsely, so a content[1] reader WOULD wake on a remote content[0]
    // change — that's safe over-firing, not tested as a negative here.)
    const notify = vi.fn();
    const dispose = reaction(() => rootB.label, notify);

    rootA.content[0] = 99; // remote change to B's content, not its label
    syncDocs(docA, docB);

    expect(rootB.content[0]).to.equal(99); // change applied
    expect(notify).not.toHaveBeenCalled(); // label reader stayed asleep

    dispose();
  });
});
