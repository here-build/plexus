import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

// ── Adversarial: does Uint8Array's copy-on-set hold the SAME invariants that
//    Y.Text breaks — and at WHICH layers does copy-on-set actually apply? ─────
//
// Uint8Array is the sibling val primitive. Unlike Y.Text it is copy-on-set
// (decorators.ts:164 — `value instanceof Uint8Array ? new Uint8Array(value) : value`),
// so the aliasing/clone/same-instance breaks that corrupt Y.Text SHOULD be
// caught by the copy. This suite checks whether that copy discipline reaches
// every layer (scalar set, container element, clone, liminality) or only the
// scalar setter. Any non-green is a copy-on-set GAP. (GC is out of scope.)

beforeAll(() => {
  enableMobXIntegration();
});

@syncing("BlobHolder")
class BlobHolder extends PlexusModel {
  @syncing accessor content!: Uint8Array;
  @syncing accessor label!: string;
}

@syncing("TwoBlob")
class TwoBlob extends PlexusModel {
  @syncing accessor a!: Uint8Array;
  @syncing accessor b!: Uint8Array;
}

@syncing("BlobList")
class BlobList extends PlexusModel {
  @syncing.list accessor items!: Uint8Array[];
}

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
}

describe("REPARENTING — copy-on-set should prevent sharing", () => {
  it("aliasing one field into another yields independent bytes", () => {
    const { root } = initTestPlexus<TwoBlob>(
      new TwoBlob({ a: new Uint8Array([1, 1, 1]), b: new Uint8Array([2, 2, 2]) }),
    );

    root.b = root.a;
    root.a[0] = 99;

    expect(root.b[0]).to.not.equal(99); // b independent of a
  });

  it("the same Uint8Array instance in two fields (ctor) yields independent bytes", () => {
    const shared = new Uint8Array([5, 5, 5]);
    const { root } = initTestPlexus<TwoBlob>(new TwoBlob({ a: shared, b: shared }));

    root.a[0] = 99;
    expect(root.b[0]).to.equal(5); // independent — and NO Yjs crash (the Y.Text failure mode)
  });
});

describe("CLONE — should copy bytes, not share the buffer", () => {
  it("a cloned entity's bytes are independent of the original", () => {
    const { root } = initTestPlexus<BlobHolder>(new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "x" }));

    const cloned = root.clone();
    cloned.content[0] = 99;

    expect(root.content[0]).to.equal(1); // original unchanged
    expect(cloned.content[0]).to.equal(99);
  });
});

describe("CONTAINERS — does copy-on-set reach list elements?", () => {
  it("distinct buffers round-trip and stay independent", () => {
    const { root } = initTestPlexus<BlobList>(
      new BlobList({ items: [new Uint8Array([1, 1]), new Uint8Array([2, 2])] }),
    );

    expect(root.items.length).to.equal(2);
    root.items[0][0] = 99;
    expect(root.items[1][0]).to.equal(2);
  });

  it("the same Uint8Array pushed twice yields independent slots", () => {
    const { root } = initTestPlexus<BlobList>(new BlobList({ items: [] }));
    const buf = new Uint8Array([1, 2, 3]);

    root.items.push(buf);
    root.items.push(buf);
    root.items[0][0] = 99;

    expect(root.items[1][0]).to.equal(1); // independent slots
  });

  it("a caller mutating a pushed buffer must not corrupt stored bytes", () => {
    const { root } = initTestPlexus<BlobList>(new BlobList({ items: [] }));
    const buf = new Uint8Array([1, 2, 3]);

    root.items.push(buf);
    buf[0] = 99; // mutate the caller's buffer AFTER push

    expect(root.items[0][0]).to.equal(1); // copy-on-push held
  });
});

describe("EPHEMERAL — Uint8Array edits inside a liminality session", () => {
  it("a byte change made during liminality REVERTS on revertLiminality", () => {
    const { plexus, root } = initTestPlexus<BlobHolder>(
      new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "x" }),
    );

    plexus.enterLiminality();
    root.content[0] = 99;
    expect(root.content[0]).to.equal(99);

    plexus.revertLiminality();
    expect(root.content[0]).to.equal(1); // preview edit discarded
  });

  it("a byte change made during liminality PERSISTS on commit and is one undo step", () => {
    const { plexus, root } = initTestPlexus<BlobHolder>(
      new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "x" }),
    );

    plexus.enterLiminality();
    root.content[0] = 99;
    plexus.commitLiminality();
    expect(root.content[0]).to.equal(99);

    plexus.undo();
    expect(root.content[0]).to.equal(1); // reverted by main undo
  });
});

describe("MATERIALIZATION — remote reassignment", () => {
  it("a remote field reassignment yields the new bytes on the peer", () => {
    const { doc: docA, root: rootA } = initTestPlexus<BlobHolder>(
      new BlobHolder({ content: new Uint8Array([1, 2, 3]), label: "a" }),
    );
    const docB = new Y.Doc({ guid: docA.guid });
    syncDocs(docA, docB);
    const { root: rootB } = connectTestPlexus<BlobHolder>(docB);

    rootA.content = new Uint8Array([7, 8, 9]);
    syncDocs(docA, docB);

    expect([...rootB.content]).to.deep.equal([7, 8, 9]);
  });
});
