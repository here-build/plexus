import { createHash } from "node:crypto";

import { autorun, reaction } from "mobx";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusTypedArrayAliasError, PlexusUnstorableValueError } from "../../errors.js";
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

  it("ALL-OR-NOTHING: a reader of one index re-runs on a write to a DIFFERENT index", () => {
    // The buffer is one atom `(owner, "content")`; there is no per-index tracking.
    // A reader of content[0] therefore wakes on a content[1] write — bytes are an
    // opaque payload revised as a unit, so sub-buffer precision would be false.
    // (Value-gated `reaction` wouldn't see it — content[0] is unchanged — so count
    // re-computations with `autorun` to prove the dependency woke.)
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const compute = vi.fn(() => root.content[0]);
    const dispose = autorun(compute);
    expect(compute).toHaveBeenCalledTimes(1); // initial run

    root.content[1] = 99; // a DIFFERENT index still wakes the content[0] reader
    expect(compute).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("ALL-OR-NOTHING: a mutating method wakes an index reader (whole-buffer atom)", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    const compute = vi.fn(() => root.content[0]);
    const dispose = autorun(compute);
    expect(compute).toHaveBeenCalledTimes(1);

    root.content.fill(0); // bulk write — the index reader wakes
    expect(compute).toHaveBeenCalledTimes(2);

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

    // An index reader on doc B. Reads depend on the field atom `(owner, "content")`
    // and B's model observer fires that same atom on a remote change, so the reader
    // wakes — reactivity is all-or-nothing and identical for local and remote.
    const notify = vi.fn();
    const dispose = reaction(() => rootB.content[0], notify);

    rootA.content[0] = 42; // local write on A
    syncDocs(docA, docB); // → remote change on B

    expect(rootB.content[0]).to.equal(42);
    expect(notify).toHaveBeenCalled();

    dispose();
  });

  it("ALL-OR-NOTHING (remote): a content[0] reader wakes on a remote write to content[1]", () => {
    // The same all-or-nothing grain holds remotely: a remote write to a DIFFERENT
    // index wakes an index reader on the peer, because the model observer fires the
    // whole field atom `(owner, "content")` — never a per-index tracker.
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "a" });
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(holder);
    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    const compute = vi.fn(() => rootB.content[0]);
    const dispose = autorun(compute);
    expect(compute).toHaveBeenCalledTimes(1);

    rootA.content[1] = 99; // remote write to a DIFFERENT index
    syncDocs(docA, docB);

    expect(rootB.content[1]).to.equal(99);
    expect(compute).toHaveBeenCalledTimes(2); // content[0] reader woke coarsely

    dispose();
  });

  it("NEGATIVE: a remote byte change does not wake a sibling-field reaction", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1, 2, 3, 4]), label: "start" });
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(holder);
    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    // Byte changes fire only `(owner, "content")` (the field atom), so a reader of a
    // SIBLING field stays asleep — reactivity is field-scoped (all-or-nothing WITHIN
    // the buffer, but never crossing to another field).
    const notify = vi.fn();
    const dispose = reaction(() => rootB.label, notify);

    rootA.content[0] = 99; // remote change to B's content, not its label
    syncDocs(docA, docB);

    expect(rootB.content[0]).to.equal(99); // change applied
    expect(notify).not.toHaveBeenCalled(); // label reader stayed asleep

    dispose();
  });

  // ── Serialization boundary: subclass normalization + the unstorable door ────

  it("normalizes a Node Buffer (Uint8Array subclass) to a plain Uint8Array on store", () => {
    // isomorphic-git and other Node consumers hand us a Buffer, whose
    // `.constructor` is Buffer, not Uint8Array — yjs's typeMapSet switches on the
    // EXACT constructor and would otherwise throw "Unexpected content type" deep
    // in its internals. Materializing this holder at all proves the normalization.
    const holder = new BlobHolder({ content: Buffer.from([0, 255, 128, 1]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    expect(Array.from(root.content)).to.deep.equal([0, 255, 128, 1]);
    // stored as the plain class, not the Buffer subclass
    expect(root.content.slice().constructor).to.equal(Uint8Array);

    // the live-set path normalizes a Buffer too
    root.content = Buffer.from([9, 8]);
    expect(Array.from(root.content)).to.deep.equal([9, 8]);
    expect(root.content.slice().constructor).to.equal(Uint8Array);
  });

  it("rejects an unstorable val value with a PlexusUnstorableValueError door", () => {
    const holder = new BlobHolder({ content: new Uint8Array([1]), label: "x" });
    const { root } = initTestPlexus<BlobHolder>(holder);

    // A function can't be stored in a CRDT field — yjs throws a bare "Unexpected
    // content type"; the boundary re-presents it as a door naming entity/field/type.
    // (label is typed `string`; cast to bypass the type guard for the test.)
    expect(() => {
      (root as unknown as { label: unknown }).label = () => "nope";
    }).to.throw(PlexusUnstorableValueError);
  });
});
