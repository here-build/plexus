/**
 * THROW-INSIDE-TRANSACTION — COMPLETE BEHAVIOR CHARACTERIZATION
 * ════════════════════════════════════════════════════════════════════════════
 * "What happens when a callback inside Plexus's transaction internals THROWS?"
 *
 * This file is the SINGLE source of truth for that question. It supersedes the
 * earlier throw-parity test and folds its findings in. Every test PINS THE
 * ACTUAL CURRENT BEHAVIOR as a green assertion — nothing here is aspirational
 * and nothing is "fixed". The goal is a behavior MAP so we can see at a glance
 * exactly where the all-or-nothing intent holds and where it breaks.
 *
 * ─── THE SUBSTRATE FACT (yjs, not ours) ─────────────────────────────────────
 * `doc.transact(f)` mutates the structs IMMEDIATELY and runs `f` inside
 * `try { } finally { cleanupTransactions() }`. If `f` throws, the `finally`
 * STILL commits the pre-throw writes and fires `'update'` (broadcasting to
 * peers) BEFORE the exception propagates. There is NO rollback, anywhere.
 *
 * ─── WHAT PLEXUS ADDS ───────────────────────────────────────────────────────
 * `maybeTransacting(doc, fn)` (utils/utils.ts) is the one helper every mutation
 * path funnels through. On throw, its OUTERMOST `catch` does
 * `pendingNotifications.clear()` — discarding the local MobX notification flush
 * for THAT batch — then re-throws. The write already committed + broadcast; only
 * the LOCAL observer notification is dropped. Three layers share this machinery:
 *   Layer 1  raw `doc.transact`   — the bare yjs primitive
 *   Layer 2  `maybeTransacting`   — the internal helper
 *   Layer 3  `Plexus.transact`    — `maybeTransacting(liminalDoc, fn)`
 * Layers 1–3 share this machinery → identical throw behavior (partial COMMITS).
 *
 * Layer 4  `@syncing.action` is the spec-based engine (`action-buffer.ts`). It
 * does NOT hold a transaction open — it DEFERS every yjs write into a buffer and
 * flushes on completion. Its throw DEFAULT is COMMIT-ON-CRASH, the same verdict
 * as layers 1–3: the pre-throw writes reach the model + wire. The one subtlety is
 * that because it defers and REPLAYS in a clean tx (the throw happened in the body,
 * not in the flush), the flush's notification is NOT discarded — so the local
 * observer is left FRESH, not stale (the mirror-image of layers 2/3). Real
 * all-or-nothing rollback is OPT-IN, per method, via
 * `@syncing.action({ rollbackIf: (error) => boolean })`: a matching predicate
 * discards the buffer (wire stays pure) and inverses the overlay. The layer-4 and
 * nested-atomic rows below pin both the default and the opt-in.
 *
 * ─── THE FOUR OBSERVERS (recorded per cell) ─────────────────────────────────
 *   (a) MODEL     — the entity itself (read-overlay / backingStorage)
 *   (b) PEER      — a synced peer Y.Doc, fed the main-doc `'update'`
 *   (c) OBSERVER  — a local MobX `autorun` registered BEFORE the call
 *   (d) UNDO      — does `plexus.undo()` revert the committed partial?
 *
 * ─── THE HEADLINE ───────────────────────────────────────────────────────────
 * "Atomic" is a claim about how a SUCCESSFUL update is delivered, NOT a
 * transactional all-or-nothing guarantee against exceptions. Across EVERY
 * mutation kind and timing: the partial COMMITS to the model and BROADCASTS to
 * peers; only the local observer is left STALE; and `undo()` is the only thing
 * that behaves like a rollback (cleanly, in one step — and it re-converges the
 * peer too).
 */
import { autorun } from "mobx";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { entityClasses } from "../../globals.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { maybeTransacting } from "../../utils/utils.js";
import { connectTestPlexus, initTestPlexus, type TestPlexus } from "../_helpers/test-plexus.js";

// A leaf entity — used as a child-val target, collection member, materialized
// mid-callback entity, and reparent subject.
@syncing("ThrowChild")
class Child extends PlexusModel {
  @syncing
  accessor label!: string;
}

// A container with a child-set — used as the source/target of a reparent.
@syncing("ThrowBox")
class Box extends PlexusModel {
  @syncing.child.set
  accessor kids!: Set<Child>;
}

// The workhorse: one entity carrying every mutation-kind surface plus the
// atomic methods the layer-parity row needs.
@syncing("ThrowFoo")
class Foo extends PlexusModel {
  @syncing accessor a!: number;
  @syncing accessor b!: number;
  @syncing accessor c!: number;

  @syncing.child accessor kid!: Child | null; // child-val

  @syncing.set accessor tags!: Set<string>; // plain set
  @syncing.list accessor seq!: number[]; // plain list
  @syncing.map accessor dict!: Map<string, number>; // plain map
  @syncing.record accessor rec!: Record<string, number>; // record

  @syncing.child.set accessor bars!: Set<Child>; // child-set (materialization)

  @syncing.child accessor boxA!: Box | null; // reparent source
  @syncing.child accessor boxB!: Box | null; // reparent target

  /** Layer-4 parity probe: one write, then throw — commit-on-crash default. */
  @syncing.action
  atomicThrowAfterOne(): void {
    this.a = 1;
    throw new Error("boom");
  }

  /** Opt-in rollback probe: one write, then throw — the predicate discards the batch. */
  @syncing.action({ rollbackIf: () => true })
  atomicRollbackAfterOne(): void {
    this.a = 1;
    throw new Error("boom");
  }

  /** Nesting probe: an atomic method that calls another atomic method which throws. */
  @syncing.action
  outerAtomic(): void {
    this.a = 1;
    this.innerAtomicThrows();
  }

  @syncing.action
  innerAtomicThrows(): void {
    this.b = 1;
    throw new Error("boom");
  }
}

const freshFoo = (): Foo =>
  new Foo({
    a: 0,
    b: 0,
    c: 0,
    kid: null,
    tags: new Set<string>(),
    seq: [],
    dict: new Map<string, number>(),
    rec: {},
    bars: new Set<Child>(),
    boxA: new Box({ kids: new Set<Child>([new Child({ label: "m" })]) }),
    boxB: new Box({ kids: new Set<Child>() }),
  });

describe("throw inside a transaction — complete behavior characterization", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<Foo>;
  let root: Foo;
  let cleanups: Array<() => void>;

  // Local-observer assertions need the MobX tracking hook wired up. Idempotent + global.
  beforeAll(() => {
    enableMobXIntegration();
  });

  beforeEach(() => {
    entityClasses.set("ThrowFoo", Foo);
    entityClasses.set("ThrowChild", Child);
    entityClasses.set("ThrowBox", Box);
    const result = initTestPlexus(freshFoo());
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
    cleanups = [];
  });

  afterEach(() => {
    for (const dispose of cleanups) dispose();
    entityClasses.clear();
  });

  // A peer that syncs the MAIN doc (entities live on the shadow; committed
  // writes forward shadow→main, and we forward main→peer). Snapshots the
  // CURRENT main state at call time, so create it AFTER any committed setup.
  function syncedPeer(): Foo {
    const peerDoc = new Y.Doc({ guid: doc.guid });
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
    const { root: peerRoot } = connectTestPlexus<Foo>(peerDoc);
    const forward = (update: Uint8Array, origin: unknown): void => {
      if (origin === "from-peer") return;
      Y.applyUpdate(peerDoc, update, "from-peer");
    };
    doc.on("update", forward);
    cleanups.push(() => {
      doc.off("update", forward);
      peerDoc.destroy();
    });
    return peerRoot;
  }

  // Records every value a reactive read takes. autorun runs once immediately
  // (baseline), then again only when a flushed notification fires. A suppressed
  // flush ⇒ the array never grows past its baseline.
  function observe<T>(read: () => T): T[] {
    const seen: T[] = [];
    const dispose = autorun(() => {
      seen.push(read());
    });
    cleanups.push(dispose);
    return seen;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP A — LAYER PARITY: the same partial-then-throw at all four layers
  // ══════════════════════════════════════════════════════════════════════════

  it("layer 1 (raw doc.transact): partial write COMMITS and fires 'update' on throw — no rollback", () => {
    const rawDoc = new Y.Doc();
    const ymap = rawDoc.getMap<number>("m");
    let updates = 0;
    rawDoc.on("update", () => updates++);

    expect(() =>
      rawDoc.transact(() => {
        ymap.set("count", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(ymap.get("count")).toBe(1); // yjs's finally committed the write…
    expect(updates).toBe(1); // …and broadcast it despite the throw.

    rawDoc.destroy();
  });

  it("layer 2 (maybeTransacting): partial COMMITS, exactly ONE shadow update, local observer STALE", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    const seen = observe(() => root.a);

    expect(() =>
      maybeTransacting(root.__doc__, () => {
        root.a = 1;
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.a).toBe(1); // (a) committed
    expect(shadowUpdates).toBe(1); // one real transaction, no compensating tx
    expect(seen).toEqual([0]); // (c) flush suppressed → observer never re-ran
  });

  it("layer 3 (Plexus.transact): partial COMMITS, ONE shadow update, observer STALE — identical to layer 2", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    const seen = observe(() => root.a);

    expect(() =>
      plexus.transact(() => {
        root.a = 1;
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.a).toBe(1);
    expect(shadowUpdates).toBe(1);
    expect(seen).toEqual([0]);
  });

  it("layer 4 (@syncing.action): COMMIT-ON-CRASH by default — partial commits like layers 1–3, but observer stays FRESH", () => {
    // The spec-based @syncing.action engine DEFERS every yjs write into a buffer
    // and, by default, FLUSHES the pre-throw writes before rethrowing (commit-on-
    // crash — matching JS + yjs finalization). Unlike layers 2/3, the throw happens
    // in the BODY, not inside the flush's maybeTransacting, so the flush completes
    // normally and its notification is NOT discarded → the observer is left FRESH.
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    const seen = observe(() => root.a);

    expect(() => root.atomicThrowAfterOne()).toThrow("boom");

    expect(root.a).toBe(1); // committed (buffer flushed before rethrow)
    expect(shadowUpdates).toBe(1); // one clean flush transaction
    expect(seen).toEqual([0, 1]); // observer SAW the commit (flush not suppressed)
  });

  it("layer 4 opt-in (@syncing.action({ rollbackIf })): a matching predicate ROLLS BACK — no commit, no update", () => {
    // Opt-in rollback: the predicate matches the thrown error, so the buffer is
    // discarded (yjs never touched → wire pure) and the overlay is inversed.
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    const seen = observe(() => root.a);

    expect(() => root.atomicRollbackAfterOne()).toThrow("boom");

    expect(root.a).toBe(0); // rolled back (buffer discarded)
    expect(shadowUpdates).toBe(0); // nothing committed → wire pure
    expect(seen).toEqual([0]); // observer sees no net change
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP B — MUTATION KIND × (model / peer / observer / undo)
  // Each kind commits the partial the SAME way: model committed, peer sees it,
  // observer stale, undo reverts. Run via Plexus.transact (the maybeTransacting
  // path); GROUP A proved the layer doesn't matter.
  // ══════════════════════════════════════════════════════════════════════════

  it("val set: COMMITS to model + peer; observer STALE; undo reverts", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.a);

    expect(() =>
      plexus.transact(() => {
        root.a = 1;
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.a).toBe(1); // (a)
    expect(peer.a).toBe(1); // (b) broadcast reached the wire
    expect(seen).toEqual([0]); // (c) stale
    plexus.undo();
    expect(root.a).toBe(0); // (d) undo reverts
  });

  it("child-val set: COMMITS to model + peer; observer STALE; undo reverts", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.kid?.label ?? "none");

    expect(() =>
      plexus.transact(() => {
        root.kid = new Child({ label: "k" });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.kid?.label).toBe("k"); // (a)
    expect(peer.kid?.label).toBe("k"); // (b)
    expect(seen).toEqual(["none"]); // (c)
    plexus.undo();
    expect(root.kid).toBeNull(); // (d)
  });

  it("set add: COMMITS to model + peer; observer STALE; undo reverts", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.tags.size);

    expect(() =>
      plexus.transact(() => {
        root.tags.add("x");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.tags.has("x")).toBe(true); // (a)
    expect(peer.tags.has("x")).toBe(true); // (b)
    expect(seen).toEqual([0]); // (c)
    plexus.undo();
    expect(root.tags.size).toBe(0); // (d)
  });

  it("list add: COMMITS to model + peer; observer STALE; undo reverts", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.seq.length);

    expect(() =>
      plexus.transact(() => {
        root.seq.push(7);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect([...root.seq]).toEqual([7]); // (a)
    expect([...peer.seq]).toEqual([7]); // (b)
    expect(seen).toEqual([0]); // (c)
    plexus.undo();
    expect(root.seq.length).toBe(0); // (d)
  });

  it("map set: COMMITS to model + peer; observer STALE; undo reverts", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.dict.get("x") ?? -1);

    expect(() =>
      plexus.transact(() => {
        root.dict.set("x", 9);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.dict.get("x")).toBe(9); // (a)
    expect(peer.dict.get("x")).toBe(9); // (b)
    expect(seen).toEqual([-1]); // (c)
    plexus.undo();
    expect(root.dict.has("x")).toBe(false); // (d)
  });

  it("record set: COMMITS to model + peer; observer STALE; undo reverts", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.rec.x ?? -1);

    expect(() =>
      plexus.transact(() => {
        root.rec.x = 9;
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.rec.x).toBe(9); // (a)
    expect(peer.rec.x).toBe(9); // (b)
    expect(seen).toEqual([-1]); // (c)
    plexus.undo();
    expect(root.rec.x).toBeUndefined(); // (d)
  });

  it("collection DELETE: COMMITS the removal to model + peer; observer STALE; undo restores the element", () => {
    // Committed setup, then a capture boundary so undo of the DELETE doesn't
    // also undo the ADD.
    plexus.transact(() => {
      root.tags.add("drop");
    });
    plexus.stopCapturing();

    const peer = syncedPeer(); // peer snapshots WITH "drop"
    expect(peer.tags.has("drop")).toBe(true);
    const seen = observe(() => (root.tags.has("drop") ? "present" : "gone"));

    expect(() =>
      plexus.transact(() => {
        root.tags.delete("drop");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.tags.has("drop")).toBe(false); // (a) deletion committed
    expect(peer.tags.has("drop")).toBe(false); // (b) broadcast
    expect(seen).toEqual(["present"]); // (c) observer still shows pre-delete
    plexus.undo();
    expect(root.tags.has("drop")).toBe(true); // (d) undo brings it back
  });

  it("entity MATERIALIZATION: a child `new`-ed mid-callback SURVIVES the throw (uuid resolves, loadable, broadcast); undo removes it", () => {
    const peer = syncedPeer();
    const seen = observe(() => root.bars.size);
    let createdUuid = "";

    expect(() =>
      plexus.transact(() => {
        const fresh = new Child({ label: "fresh" });
        root.bars.add(fresh);
        createdUuid = fresh.uuid; // resolves mid-transaction — fully materialized
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.bars.size).toBe(1); // (a) the half-materialized entity persisted
    expect([...root.bars][0]?.label).toBe("fresh");
    expect(() => [...root.bars][0]?.uuid).not.toThrow(); // uuid is stable
    expect(plexus.loadEntity(createdUuid)).toBeTruthy(); // it is a real, loadable entity
    expect(peer.bars.size).toBe(1); // (b) broadcast to the peer
    expect(seen).toEqual([0]); // (c) observer stale
    plexus.undo();
    expect(root.bars.size).toBe(0); // (d) undo removes the materialized child
  });

  it("REPARENT / move: the move COMMITS despite the throw (child detached from A, attached to B); undo restores the original parent", () => {
    const child = [...root.boxA!.kids][0]!;
    const peer = syncedPeer();

    expect(() =>
      plexus.transact(() => {
        root.boxB!.kids.add(child); // reparent A→B (ownership transfer auto-detaches A)
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.boxA!.kids.size).toBe(0); // (a) detached from old parent
    expect(root.boxB!.kids.size).toBe(1); //     attached to new parent
    expect(peer.boxA!.kids.size).toBe(0); // (b) broadcast
    expect(peer.boxB!.kids.size).toBe(1);
    plexus.undo();
    expect(root.boxA!.kids.size).toBe(1); // (d) undo moves it back
    expect(root.boxB!.kids.size).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP C — THROW TIMING
  // ══════════════════════════════════════════════════════════════════════════

  it("throw BEFORE any write: nothing commits, NO update is emitted, observer untouched (empty transaction)", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    const seen = observe(() => root.a);

    expect(() =>
      plexus.transact(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.a).toBe(0); // nothing written
    expect(shadowUpdates).toBe(0); // yjs emits no 'update' for an empty transaction
    expect(seen).toEqual([0]); // observer untouched — this case IS clean
  });

  it("throw AFTER N writes: ALL N writes commit (model + peer); observer STALE; ONE undo reverts ALL of them", () => {
    const peer = syncedPeer();
    const seen = observe(() => `${root.a},${root.b},${root.c}`);

    expect(() =>
      plexus.transact(() => {
        root.a = 1;
        root.b = 2;
        root.c = 3; // 3 writes…
        throw new Error("boom"); // …then throw
      }),
    ).toThrow("boom");

    expect([root.a, root.b, root.c]).toEqual([1, 2, 3]); // (a) ALL three committed
    expect([peer.a, peer.b, peer.c]).toEqual([1, 2, 3]); // (b) ALL three broadcast
    expect(seen).toEqual(["0,0,0"]); // (c) observer saw NONE
    plexus.undo();
    expect([root.a, root.b, root.c]).toEqual([0, 0, 0]); // (d) one undo step reverts all
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP D — NESTING & CATCHING (the real semantics of "throw in the internals")
  // ══════════════════════════════════════════════════════════════════════════

  it("inner-nested throw: BOTH outer and inner writes COMMIT, but the OUTERMOST catch discards ALL notifications", () => {
    const peer = syncedPeer();
    const seen = observe(() => `${root.a},${root.b}`);

    expect(() =>
      plexus.transact(() => {
        root.a = 1; // outer write
        plexus.transact(() => {
          // nested = shadow sub-transaction
          root.b = 1; // inner write
          throw new Error("boom"); // throw escapes BOTH
        });
      }),
    ).toThrow("boom");

    expect([root.a, root.b]).toEqual([1, 1]); // both committed (one yjs transaction)
    expect([peer.a, peer.b]).toEqual([1, 1]); // both broadcast
    expect(seen).toEqual(["0,0"]); // observer saw NEITHER — outer cleared the whole batch
  });

  it("inner-nested throw via @syncing.action: neither frame opts into rollback → BOTH writes COMMIT-ON-CRASH in one flush", () => {
    const peer = syncedPeer();
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    expect(() => root.outerAtomic()).toThrow("boom");

    // The nested atomic defers into the OUTERMOST buffer (savepoint slice). The inner
    // throw escapes to the outer runAction; with no rollbackIf on either frame it is
    // commit-on-crash, so the outermost frame flushes the whole buffer once, then
    // rethrows. Both writes reach the model + wire in a single transaction.
    expect(root.a).toBe(1); // outer write committed
    expect(root.b).toBe(1); // inner pre-throw write committed
    expect([peer.a, peer.b]).toEqual([1, 1]); // both broadcast
    expect(shadowUpdates).toBe(1); // one flush transaction for the whole buffer
  });

  it("throw CAUGHT inside the callback: the transaction completes NORMALLY → flush fires → observer SEES the write", () => {
    const seen = observe(() => root.a);

    // The callback swallows its own throw, so maybeTransacting never sees one.
    plexus.transact(() => {
      try {
        root.a = 1;
        throw new Error("boom");
      } catch {
        /* swallowed — normal completion follows */
      }
    });

    expect(root.a).toBe(1); // write committed (as always)
    expect(seen).toEqual([0, 1]); // NORMAL flush — observer updated (NOT stale)
    plexus.undo();
    expect(root.a).toBe(0); // undo works normally too
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP E — UNDO AS ROLLBACK (the one mechanism that behaves like all-or-nothing)
  // ══════════════════════════════════════════════════════════════════════════

  it("undo IS a clean rollback for a thrown partial — and it RE-CONVERGES the peer (undo broadcasts too)", () => {
    const peer = syncedPeer();

    expect(() =>
      plexus.transact(() => {
        root.a = 5;
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(root.a).toBe(5); // diverged: model committed…
    expect(peer.a).toBe(5); // …peer too…
    // …observer was the only stale party (GROUP B). Undo fixes the divergence:
    plexus.undo();
    expect(root.a).toBe(0); // model rolled back
    expect(peer.a).toBe(0); // peer rolled back via the undo broadcast
  });
});
