import { describe, expect, it } from "vitest";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

/**
 * ROUTING PARITY — the total-alphabet harness for `@syncing.action`.
 *
 * Every routed emission site is three hand-written functions that must agree:
 * `applyNow` ≡ `overlay` + `describe`, and `revertOverlay` ≡ `overlay`⁻¹. Nothing
 * in the type system can enforce that agreement — it is a simulation argument,
 * hand-written once per site. The only possible enforcement is OBSERVATIONAL,
 * so this file runs one invariant over the whole op alphabet instead of
 * sampling behaviors with bespoke tests:
 *
 *   1. DEFERRED ≡ EAGER — the same mutation on a fresh doc must produce the
 *      same observable state whether it runs inside an action or bare.
 *   2. DURING THE BODY — reads see the op (overlay read-your-writes) while yjs
 *      stays silent (zero update events; genesis defers to flush too).
 *   3. COMMIT TX COUNT — exactly one flush transaction, plus one genesis
 *      transaction per entity materialized at flush (pinned by the decorator
 *      suite's (a2): genesis deliberately rides its own origin).
 *   4. ROLLBACK ≡ IDENTITY — with a matching `rollbackIf`, observable state
 *      returns to the pre-action snapshot exactly and yjs never saw anything.
 *   5. POST-ROLLBACK PROBE — the same mutation re-run eagerly on the
 *      rolled-back root must land correctly: a `revertOverlay` that corrupts
 *      the mirror (stale snapshot, wrong splice) fails here even when the
 *      state projection above happens to match.
 *
 * A newly routed site later = one new alphabet entry below.
 *
 * Deliberately OUTSIDE the harness (parent-side projections only):
 *   - child BACK-POINTER visibility during the body — `child.parent` reads the
 *     STAGED ownership layer mid-body (live reads; the real pointers settle at
 *     flush); pinned separately in the decorator suite, not here.
 *   - `copyWithin`/`fill` on CHILD lists — duplicate-reference territory with
 *     its own warning path, not a parity target.
 *   - `setFromBase64`/`setFromHex`/`reverse`/`copyWithin` on byte fields —
 *     they funnel through the same single `commit(next)` site as `fill`/`set`/
 *     `sort`/index-assign; the funnel is what parity proves.
 */

/** The rollback trigger — matched by `rollbackIf`, never by accident. */
class RollbackSignal extends Error {
  constructor() {
    super("parity-rollback");
  }
}

@syncing("ParityLeaf")
class Leaf extends PlexusModel {
  @syncing
  accessor label!: string;
}

@syncing("ParityRoot")
class Root extends PlexusModel {
  @syncing
  accessor num!: number;

  @syncing.child
  accessor kid: Leaf | null = null;

  @syncing.list
  accessor vlist: number[] = [];

  @syncing.child.list
  accessor clist: Leaf[] = [];

  @syncing.set
  accessor vset: Set<string> = new Set();

  @syncing.child.set
  accessor cset: Set<Leaf> = new Set();

  @syncing.map
  accessor vmap!: Map<string, number>;

  @syncing.child.map
  accessor cmap!: Map<string, Leaf>;

  @syncing.record
  accessor vrec: Record<string, string> = {};

  @syncing.child.record
  accessor crec: Record<string, Leaf> = {};

  @syncing
  accessor bytes!: Uint8Array;

  /** Generic action body — the harness injects the op under test. */
  @syncing.action
  act(fn: (self: Root) => void): void {
    fn(this);
  }

  /** Same, but every run rolls back (the signal is thrown after the op). */
  @syncing.action({ rollbackIf: (e) => e instanceof RollbackSignal })
  actRollback(fn: (self: Root) => void): void {
    fn(this);
    throw new RollbackSignal();
  }
}

/** `assign`/`clear` are runtime proxy surface not present on the plain field types. */
const ext = <T extends object>(field: T) => field as T & { assign(value: unknown): void; clear(): void };

const fresh = (): Root =>
  initTestPlexus(
    new Root({
      num: 0,
      kid: null,
      vlist: [],
      clist: [],
      vset: new Set(),
      cset: new Set(),
      vmap: new Map(),
      cmap: new Map(),
      vrec: {},
      crec: {},
      bytes: new Uint8Array(0),
    }),
  ).root;

/** Find an owned leaf by label — entries locate their targets structurally. */
const leafIn = (all: Iterable<Leaf>, label: string): Leaf => {
  for (const leaf of all) if (leaf.label === label) return leaf;
  throw new Error(`no leaf labeled ${label}`);
};

interface Entry {
  name: string;
  /** Eager pre-state; runs before any update counter attaches. */
  setup?: (r: Root) => void;
  /** The op under test — must be doc-independent (constructs its own entities). */
  mutate: (r: Root) => void;
  /** Plain-JSON projection of the affected state; comparable across docs. */
  observe: (r: Root) => unknown;
  /** Entities materialized at flush — each rides its own genesis tx (a2). */
  genesisTxs?: number;
  /**
   * Pre-existing post-flush observer residue, pinned at its measured value.
   * The child-map mirror observer (map.ts, isChildField branch) re-derives
   * ownership for LOCAL writes too — its informAdoption tears down and rebuilds
   * parent data in follow-up transactions (orphanize + genesis echo + adopt = 3).
   * Probe-verified identical in eager mode (eager cmap.set = 4 updates, action
   * = 5 = eager + 1 genesis): NOT caused by the deferral routing. Orphanization
   * is parent-guarded, so delete/clear entries see no residue; adoption is not.
   */
  observerTxs?: number;
}

function runParity(entry: Entry): void {
  // 1) EAGER — the oracle. Same mutation, no action anywhere near it. The oracle
  // is STATE-only: transaction-count equality between modes is deliberately NOT
  // asserted, because it is not an invariant of the design — eager runs one tx
  // per op (the action batches all ops into one flush), and eager leaves child
  // ownership bookkeeping to post-tx yjs observers while the deferred path must
  // do it inline (mid-body read-your-writes has no yjs observer to lean on).
  const eager = fresh();
  entry.setup?.(eager);
  entry.mutate(eager);
  const expected = entry.observe(eager);

  // 2) ACTION-COMMIT — deferred must be observationally identical.
  const commit = fresh();
  entry.setup?.(commit);
  let updates = 0;
  commit.__doc__!.on("update", () => updates++);
  commit.act((self) => {
    entry.mutate(self);
    expect(updates, "yjs must stay silent during the body").toBe(0);
    expect(entry.observe(self), "overlay must show the op during the body").toEqual(expected);
  });
  expect(entry.observe(commit), "deferred ≡ eager (final state)").toEqual(expected);
  // The engine's tx envelope: one flush tx, plus one genesis tx per entity
  // materialized at flush (each genesis deliberately rides its own origin — a2),
  // plus any pinned post-flush observer residue (see Entry.observerTxs).
  expect(updates, "one flush tx + genesis txs + pinned observer residue").toBe(
    1 + (entry.genesisTxs ?? 0) + (entry.observerTxs ?? 0),
  );

  // 3) ACTION-ROLLBACK — identity, with yjs untouched.
  const rolled = fresh();
  entry.setup?.(rolled);
  const before = entry.observe(rolled);
  let rolledUpdates = 0;
  rolled.__doc__!.on("update", () => rolledUpdates++);
  expect(() => rolled.actRollback((self) => entry.mutate(self))).toThrow(RollbackSignal);
  expect(entry.observe(rolled), "rollback ≡ identity").toEqual(before);
  expect(rolledUpdates, "rollback leaves yjs untouched").toBe(0);

  // 4) POST-ROLLBACK PROBE — the mirror must still be live and correct: the same
  // op re-run eagerly from the restored state must land exactly like the oracle.
  entry.mutate(rolled);
  expect(entry.observe(rolled), "post-rollback eager re-run (mirror uncorrupted)").toEqual(expected);
}

// ---------------------------------------------------------------------------
// The alphabet. Projections for SETS are sorted (semantically unordered);
// lists/maps/records/bytes are observed in order.
// ---------------------------------------------------------------------------

const seeVlist = (r: Root) => [...r.vlist];
const seeClist = (r: Root) => r.clist.map((l) => l.label);
const seeVset = (r: Root) => [...r.vset].sort();
const seeCset = (r: Root) => [...r.cset].map((l) => l.label).sort();
const seeVmap = (r: Root) => [...r.vmap.entries()].sort(([a], [b]) => a.localeCompare(b));
const seeCmap = (r: Root) => [...r.cmap.entries()].map(([k, l]) => [k, l.label] as const).sort(([a], [b]) => a.localeCompare(b));
const seeVrec = (r: Root) => ({ ...r.vrec });
const seeCrec = (r: Root) => Object.fromEntries(Object.entries(r.crec).map(([k, l]) => [k, l.label]));
const seeBytes = (r: Root) => [...r.bytes];

const threeVlist = (r: Root) => void r.vlist.push(1, 2, 3);
const twoClist = (r: Root) => {
  r.clist.push(new Leaf({ label: "A" }));
  r.clist.push(new Leaf({ label: "B" }));
};

const ALPHABET: Entry[] = [
  // ---- decorators.ts: val + child-val -------------------------------------
  { name: "val: set", mutate: (r) => (r.num = 42), observe: (r) => r.num },
  {
    name: "child-val: set from null (genesis)",
    mutate: (r) => (r.kid = new Leaf({ label: "K" })),
    observe: (r) => r.kid?.label ?? null,
    genesisTxs: 1,
  },
  {
    name: "child-val: replace (orphan old + genesis new)",
    setup: (r) => (r.kid = new Leaf({ label: "OLD" })),
    mutate: (r) => (r.kid = new Leaf({ label: "NEW" })),
    observe: (r) => r.kid?.label ?? null,
    genesisTxs: 1,
  },
  {
    name: "child-val: null-out (orphan)",
    setup: (r) => (r.kid = new Leaf({ label: "GONE" })),
    mutate: (r) => (r.kid = null),
    observe: (r) => r.kid?.label ?? null,
  },

  // ---- array.ts: VALUE list ------------------------------------------------
  { name: "array(value): push", setup: threeVlist, mutate: (r) => void r.vlist.push(4), observe: seeVlist },
  { name: "array(value): unshift", setup: threeVlist, mutate: (r) => void r.vlist.unshift(0), observe: seeVlist },
  {
    name: "array(value): splice (delete + insert)",
    setup: threeVlist,
    mutate: (r) => void r.vlist.splice(1, 1, 9, 8),
    observe: seeVlist,
  },
  { name: "array(value): pop", setup: threeVlist, mutate: (r) => void r.vlist.pop(), observe: seeVlist },
  { name: "array(value): shift", setup: threeVlist, mutate: (r) => void r.vlist.shift(), observe: seeVlist },
  { name: "array(value): reverse", setup: threeVlist, mutate: (r) => void r.vlist.reverse(), observe: seeVlist },
  {
    name: "array(value): sort",
    setup: (r) => void r.vlist.push(3, 1, 2),
    mutate: (r) => void r.vlist.sort((a, b) => a - b),
    observe: seeVlist,
  },
  {
    name: "array(value): copyWithin",
    setup: threeVlist,
    mutate: (r) => void r.vlist.copyWithin(0, 1),
    observe: seeVlist,
  },
  { name: "array(value): clear", setup: threeVlist, mutate: (r) => ext(r.vlist).clear(), observe: seeVlist },
  { name: "array(value): assign", setup: threeVlist, mutate: (r) => ext(r.vlist).assign([7, 8]), observe: seeVlist },
  {
    name: "array(value): fill (generic Array.prototype fallback)",
    setup: threeVlist,
    mutate: (r) => void r.vlist.fill(9, 1),
    observe: seeVlist,
  },
  {
    name: "array(value): length-set truncation",
    setup: threeVlist,
    mutate: (r) => void (r.vlist.length = 1),
    observe: seeVlist,
  },
  { name: "array(value): index-set", setup: threeVlist, mutate: (r) => void (r.vlist[1] = 99), observe: seeVlist },

  // ---- array.ts: CHILD list --------------------------------------------------
  {
    name: "array(child): push (genesis)",
    setup: twoClist,
    mutate: (r) => void r.clist.push(new Leaf({ label: "C" })),
    observe: seeClist,
    genesisTxs: 1,
  },
  {
    name: "array(child): unshift (genesis)",
    setup: twoClist,
    mutate: (r) => void r.clist.unshift(new Leaf({ label: "C" })),
    observe: seeClist,
    genesisTxs: 1,
  },
  {
    name: "array(child): splice replaces a slot (orphan + genesis)",
    setup: twoClist,
    mutate: (r) => void r.clist.splice(1, 1, new Leaf({ label: "C" })),
    observe: seeClist,
    genesisTxs: 1,
  },
  { name: "array(child): pop (orphan)", setup: twoClist, mutate: (r) => void r.clist.pop(), observe: seeClist },
  { name: "array(child): shift (orphan)", setup: twoClist, mutate: (r) => void r.clist.shift(), observe: seeClist },
  {
    name: "array(child): clear (orphan all)",
    setup: twoClist,
    mutate: (r) => ext(r.clist).clear(),
    observe: seeClist,
  },
  {
    name: "array(child): assign (keep one, drop one, add one)",
    setup: twoClist,
    mutate: (r) => ext(r.clist).assign([r.clist[0], new Leaf({ label: "C" })]),
    observe: seeClist,
    genesisTxs: 1,
  },
  {
    name: "array(child): index-set replaces a slot (orphan + genesis)",
    setup: twoClist,
    mutate: (r) => void (r.clist[0] = new Leaf({ label: "C" })),
    observe: seeClist,
    genesisTxs: 1,
  },
  {
    name: "array(child): length-set truncation (orphan tail)",
    setup: twoClist,
    mutate: (r) => void (r.clist.length = 1),
    observe: seeClist,
  },
  { name: "array(child): reverse (pure reorder)", setup: twoClist, mutate: (r) => void r.clist.reverse(), observe: seeClist },
  {
    name: "array(child): sort (pure reorder)",
    setup: twoClist,
    mutate: (r) => void r.clist.sort((a, b) => b.label.localeCompare(a.label)),
    observe: seeClist,
  },

  // ---- set.ts: VALUE set -----------------------------------------------------
  {
    name: "set(value): add",
    setup: (r) => void (r.vset.add("a"), r.vset.add("b")),
    mutate: (r) => void r.vset.add("c"),
    observe: seeVset,
  },
  {
    name: "set(value): delete",
    setup: (r) => void (r.vset.add("a"), r.vset.add("b")),
    mutate: (r) => void r.vset.delete("a"),
    observe: seeVset,
  },
  {
    name: "set(value): clear",
    setup: (r) => void (r.vset.add("a"), r.vset.add("b")),
    mutate: (r) => r.vset.clear(),
    observe: seeVset,
  },
  {
    name: "set(value): assign",
    setup: (r) => void (r.vset.add("a"), r.vset.add("b")),
    mutate: (r) => ext(r.vset).assign(new Set(["x", "y"])),
    observe: seeVset,
  },
  {
    // assign takes Iterable<T> — a generator is consumable exactly once. Pins
    // the consume-once contract: every branch must share one snapshot of the
    // iterable, never re-spread the argument.
    name: "set(value): assign from one-shot iterable",
    setup: (r) => void (r.vset.add("a"), r.vset.add("b")),
    mutate: (r) => {
      function* oneShot(): Generator<string> {
        yield "x";
        yield "y";
      }
      ext(r.vset).assign(oneShot());
    },
    observe: seeVset,
  },

  // ---- set.ts: CHILD set -------------------------------------------------------
  {
    name: "set(child): add (genesis)",
    setup: (r) => void r.cset.add(new Leaf({ label: "A" })),
    mutate: (r) => void r.cset.add(new Leaf({ label: "B" })),
    observe: seeCset,
    genesisTxs: 1,
  },
  {
    name: "set(child): delete (orphan)",
    setup: (r) => void (r.cset.add(new Leaf({ label: "A" })), r.cset.add(new Leaf({ label: "B" }))),
    mutate: (r) => void r.cset.delete(leafIn(r.cset, "A")),
    observe: seeCset,
  },
  {
    name: "set(child): clear (orphan all)",
    setup: (r) => void (r.cset.add(new Leaf({ label: "A" })), r.cset.add(new Leaf({ label: "B" }))),
    mutate: (r) => r.cset.clear(),
    observe: seeCset,
  },
  {
    name: "set(child): assign (keep one, drop one, add one)",
    setup: (r) => void (r.cset.add(new Leaf({ label: "A" })), r.cset.add(new Leaf({ label: "B" }))),
    mutate: (r) => ext(r.cset).assign(new Set([leafIn(r.cset, "A"), new Leaf({ label: "C" })])),
    observe: seeCset,
    genesisTxs: 1,
  },

  // ---- map.ts: VALUE map ---------------------------------------------------------
  {
    name: "map(value): set first key on empty",
    mutate: (r) => void r.vmap.set("k1", 1),
    observe: seeVmap,
  },
  {
    name: "map(value): set (new key + overwrite)",
    setup: (r) => void (r.vmap.set("k1", 1), r.vmap.set("k2", 2)),
    mutate: (r) => void (r.vmap.set("k3", 3), r.vmap.set("k1", 10)),
    observe: seeVmap,
  },
  {
    name: "map(value): delete",
    setup: (r) => void (r.vmap.set("k1", 1), r.vmap.set("k2", 2)),
    mutate: (r) => void r.vmap.delete("k1"),
    observe: seeVmap,
  },
  {
    name: "map(value): clear",
    setup: (r) => void (r.vmap.set("k1", 1), r.vmap.set("k2", 2)),
    mutate: (r) => r.vmap.clear(),
    observe: seeVmap,
  },
  {
    name: "map(value): assign",
    setup: (r) => void (r.vmap.set("k1", 1), r.vmap.set("k2", 2)),
    mutate: (r) => ext(r.vmap).assign(new Map([["z", 9]])),
    observe: seeVmap,
  },

  // ---- map.ts: CHILD map -----------------------------------------------------------
  {
    name: "map(child): set new key (genesis)",
    setup: (r) => void r.cmap.set("k1", new Leaf({ label: "A" })),
    mutate: (r) => void r.cmap.set("k2", new Leaf({ label: "B" })),
    observe: seeCmap,
    genesisTxs: 1,
    observerTxs: 3, // child-map adopt re-derivation (see Entry.observerTxs)
  },
  {
    name: "map(child): overwrite key (orphan + genesis)",
    setup: (r) => void r.cmap.set("k1", new Leaf({ label: "A" })),
    mutate: (r) => void r.cmap.set("k1", new Leaf({ label: "B" })),
    observe: seeCmap,
    genesisTxs: 1,
    observerTxs: 3, // old child orphaned inline at flush (guard no-ops it); new child's adopt dance still fires
  },
  {
    name: "map(child): delete (orphan)",
    setup: (r) => void (r.cmap.set("k1", new Leaf({ label: "A" })), r.cmap.set("k2", new Leaf({ label: "B" }))),
    mutate: (r) => void r.cmap.delete("k1"),
    observe: seeCmap,
  },
  {
    name: "map(child): clear (orphan all)",
    setup: (r) => void (r.cmap.set("k1", new Leaf({ label: "A" })), r.cmap.set("k2", new Leaf({ label: "B" }))),
    mutate: (r) => r.cmap.clear(),
    observe: seeCmap,
  },
  {
    name: "map(child): assign (genesis)",
    setup: (r) => void r.cmap.set("k1", new Leaf({ label: "A" })),
    mutate: (r) => ext(r.cmap).assign(new Map([["n", new Leaf({ label: "N" })]])),
    observe: seeCmap,
    genesisTxs: 1,
    observerTxs: 3, // adopt re-derivation for the one new child (see Entry.observerTxs)
  },

  // ---- record.ts: VALUE record ---------------------------------------------------
  {
    // Every other record entry pre-fills the container in `setup`. This one
    // is the first write into an empty record — `describe()` must genesis the
    // Y.Map inside the flush tx (`ensureYjsMap`).
    name: "record(value): set first key on empty",
    mutate: (r) => void (r.vrec.x = "1"),
    observe: seeVrec,
  },
  {
    name: "record(value): set (new key + overwrite)",
    setup: (r) => void (r.vrec.a = "1", (r.vrec.b = "2")),
    mutate: (r) => void ((r.vrec.c = "3"), (r.vrec.a = "9")),
    observe: seeVrec,
  },
  {
    name: "record(value): deleteProperty",
    setup: (r) => void ((r.vrec.a = "1"), (r.vrec.b = "2")),
    mutate: (r) => void delete r.vrec.a,
    observe: seeVrec,
  },
  {
    name: "record(value): clear",
    setup: (r) => void ((r.vrec.a = "1"), (r.vrec.b = "2")),
    mutate: (r) => ext(r.vrec).clear(),
    observe: seeVrec,
  },
  {
    name: "record(value): assign",
    setup: (r) => void ((r.vrec.a = "1"), (r.vrec.b = "2")),
    mutate: (r) => ext(r.vrec).assign({ z: "7" }),
    observe: seeVrec,
  },
  {
    // assign takes Iterable<[k, v]> — a generator is consumable exactly once.
    // Pins the consume-once contract on the instant path: re-spreading the
    // argument after the shared snapshot already consumed it cleared the
    // record and repopulated NOTHING (the double-spread bug).
    name: "record(value): assign from one-shot iterable",
    setup: (r) => void ((r.vrec.a = "1"), (r.vrec.b = "2")),
    mutate: (r) => {
      function* oneShot(): Generator<[string, string]> {
        yield ["z", "7"];
        yield ["y", "8"];
      }
      ext(r.vrec).assign(oneShot());
    },
    observe: seeVrec,
  },

  // ---- record.ts: CHILD record ------------------------------------------------------
  {
    name: "record(child): set new key (genesis)",
    setup: (r) => void (r.crec.a = new Leaf({ label: "A" })),
    mutate: (r) => void (r.crec.b = new Leaf({ label: "B" })),
    observe: seeCrec,
    genesisTxs: 1,
  },
  {
    name: "record(child): overwrite key (orphan + genesis)",
    setup: (r) => void (r.crec.a = new Leaf({ label: "A" })),
    mutate: (r) => void (r.crec.a = new Leaf({ label: "B" })),
    observe: seeCrec,
    genesisTxs: 1,
  },
  {
    name: "record(child): deleteProperty (orphan)",
    setup: (r) => void ((r.crec.a = new Leaf({ label: "A" })), (r.crec.b = new Leaf({ label: "B" }))),
    mutate: (r) => void delete r.crec.a,
    observe: seeCrec,
  },
  {
    name: "record(child): clear (orphan all)",
    setup: (r) => void ((r.crec.a = new Leaf({ label: "A" })), (r.crec.b = new Leaf({ label: "B" }))),
    mutate: (r) => ext(r.crec).clear(),
    observe: seeCrec,
  },
  {
    name: "record(child): assign (genesis)",
    setup: (r) => void (r.crec.a = new Leaf({ label: "A" })),
    mutate: (r) => ext(r.crec).assign({ n: new Leaf({ label: "N" }) }),
    observe: seeCrec,
    genesisTxs: 1,
  },
  {
    // The child variant of the consume-once pin — under the double-spread bug
    // the instant path validated/orphaned/adopted against an EMPTY snapshot.
    name: "record(child): assign from one-shot iterable (genesis)",
    setup: (r) => void (r.crec.a = new Leaf({ label: "A" })),
    mutate: (r) => {
      function* oneShot(): Generator<[string, Leaf]> {
        yield ["n", new Leaf({ label: "N" })];
      }
      ext(r.crec).assign(oneShot());
    },
    observe: seeCrec,
    genesisTxs: 1,
  },

  // ---- typed-array.ts: byte val (single commit funnel) ------------------------------
  {
    name: "bytes: fill",
    setup: (r) => (r.bytes = new Uint8Array([5, 1, 4])),
    mutate: (r) => void r.bytes.fill(9),
    observe: seeBytes,
  },
  {
    name: "bytes: index-set",
    setup: (r) => (r.bytes = new Uint8Array([5, 1, 4])),
    mutate: (r) => void (r.bytes[1] = 7),
    observe: seeBytes,
  },
  {
    name: "bytes: set (bulk write)",
    setup: (r) => (r.bytes = new Uint8Array([5, 1, 4])),
    mutate: (r) => r.bytes.set([8, 8], 1),
    observe: seeBytes,
  },
  {
    name: "bytes: sort",
    setup: (r) => (r.bytes = new Uint8Array([5, 1, 4])),
    mutate: (r) => void r.bytes.sort(),
    observe: seeBytes,
  },
];

describe("@syncing.action routing parity (total alphabet)", () => {
  for (const entry of ALPHABET) {
    it(entry.name, () => runParity(entry));
  }
});
