/**
 * Where a Uint8Array may live — the value/key split.
 *
 * Bytes are payload, not identity: content-shaped but object-identified, so a fresh
 * instance with equal bytes is a different member in memory yet the same serialized
 * key in the CRDT. That makes them unfit as a set member or map key, but perfectly
 * fine as a *value* addressed by its position.
 *
 *   LEGAL   → val field, record value, array element, map value
 *   ILLEGAL → set member, map key
 *
 * The type layer forbids `Set<Uint8Array>` / `Map<Uint8Array, …>` outright (see
 * `../types/byte-placement.type-check.ts`); the runtime `validatePrimitive` throw
 * (exercised here via `as any`) is the backstop for untyped or deserialize-path
 * callers.
 *
 * Copy-on-set discipline is NOT uniform across placements, and that's deliberate —
 * see the "soft guard" block below. The exhaustive copy-on-set probe for the
 * copy-protected placements (val field, list) lives in `uint8array-invariants.test.ts`.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("ByteValues")
class ByteValues extends PlexusModel {
  @syncing.map accessor byName!: Map<string, Uint8Array>;
  @syncing.list accessor blobs: Uint8Array[] = [];
  @syncing.record accessor byKey: Record<string, Uint8Array> = {};
  // A legal set (string members) — used only to prove the runtime rejects a byte member.
  @syncing.set accessor tags!: Set<string>;
}

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("Uint8Array value placement — in-memory round-trip", () => {
  it("holds bytes as a map value, addressed by a string key", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));

    root.byName.set("logo", new Uint8Array([1, 2, 3]));

    const got = root.byName.get("logo");
    expect(got).to.be.instanceOf(Uint8Array);
    expect([...got!]).to.have.ordered.members([1, 2, 3]);
  });

  it("holds bytes as an array element", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));

    root.blobs.push(new Uint8Array([9, 8, 7]));

    expect(root.blobs).to.have.length(1);
    expect([...root.blobs[0]]).to.have.ordered.members([9, 8, 7]);
  });

  it("holds bytes as a record value", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));

    root.byKey.icon = new Uint8Array([255, 0, 255]);

    expect([...root.byKey.icon]).to.have.ordered.members([255, 0, 255]);
  });
});

describe("Uint8Array value placement — cross-peer snapshot", () => {
  // The real guarantee for byte values: on serialize, Yjs snapshots the bytes, so a
  // synced peer sees a stable, independent copy regardless of the soft guard below.
  it("map value round-trips to a peer", () => {
    const { doc: da, root: ra } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));
    ra.byName.set("logo", new Uint8Array([1, 2, 3]));

    const db = new Y.Doc({ guid: da.guid });
    syncDocs(da, db);
    const { root: rb } = connectTestPlexus<ByteValues>(db);

    expect([...rb.byName.get("logo")!]).to.deep.equal([1, 2, 3]);
  });

  it("record value round-trips to a peer", () => {
    const { doc: da, root: ra } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));
    ra.byKey.icon = new Uint8Array([4, 5, 6]);

    const db = new Y.Doc({ guid: da.guid });
    syncDocs(da, db);
    const { root: rb } = connectTestPlexus<ByteValues>(db);

    expect([...rb.byKey.icon]).to.deep.equal([4, 5, 6]);
  });

  it("array element round-trips to a peer", () => {
    const { doc: da, root: ra } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));
    ra.blobs.push(new Uint8Array([7, 8, 9]));

    const db = new Y.Doc({ guid: da.guid });
    syncDocs(da, db);
    const { root: rb } = connectTestPlexus<ByteValues>(db);

    expect([...rb.blobs[0]]).to.deep.equal([7, 8, 9]);
  });
});

describe("Uint8Array value placement — soft guard: caller owns the buffer (record/map values)", () => {
  // ACKNOWLEDGED DESIGN DECISION, not a bug. Copy-on-set (`new Uint8Array(value)`)
  // fires only on the scalar/val setter (decorators.ts) and, via Yjs insert, on list
  // pushes — those placements are copy-protected (see uint8array-invariants.test.ts).
  // Record and map value writes do NOT copy: they hold the caller's buffer by
  // reference until the next serialize. Adding a defensive copy would mean a buffer
  // clone on every record/map write in the already-~10× slower yjs-synced path — a
  // cost we decline. The contract for these placements is "the buffer is ours once
  // written; don't keep mutating it." These tests pin that behavior so it stays
  // intentional and visible; the cross-peer snapshot above is unaffected either way.
  it("mutating the source buffer after a record-value write leaks (no defensive copy)", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));
    const buf = new Uint8Array([1, 2, 3]);

    root.byKey.icon = buf;
    buf[0] = 99;

    expect(root.byKey.icon[0]).to.equal(99); // soft guard: caller-owned buffer
  });

  it("mutating the source buffer after a map-value write leaks (no defensive copy)", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));
    const buf = new Uint8Array([1, 2, 3]);

    root.byName.set("icon", buf);
    buf[0] = 99;

    expect(root.byName.get("icon")![0]).to.equal(99); // soft guard: caller-owned buffer
  });
});

describe("Uint8Array is rejected as a set member / map key", () => {
  it("rejects a Uint8Array set member at runtime (backstop)", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));

    expect(() => root.tags.add(new Uint8Array([1, 2, 3]) as any)).to.throw(
      TypeError,
      /Uint8Array is not allowed as a map key or set member/,
    );
  });

  it("rejects a Uint8Array map key at runtime (backstop)", () => {
    const { root } = initTestPlexus<ByteValues>(new ByteValues({ byName: new Map(), tags: new Set() }));

    expect(() => (root.byName as any).set(new Uint8Array([1, 2, 3]), new Uint8Array([4]))).to.throw(
      TypeError,
      /Uint8Array is not allowed as a map key or set member/,
    );
  });
});
