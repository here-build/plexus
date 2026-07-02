import { reaction } from "mobx";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusCycleError } from "../../errors.js";
import { entityClasses } from "../../globals.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { maybeTransacting } from "../../utils/utils.js";
import { initTestPlexus, type TestPlexus } from "../_helpers/test-plexus.js";

// A child entity materialized mid-method by the atomic body.
@syncing("AtomicBar")
class Bar extends PlexusModel {
  @syncing
  accessor label!: string;
}

// Lives on its OWN plexus/doc — used to exercise the multi-doc path (each doc
// mutated by an atomic body gets its own single transaction).
@syncing("AtomicOther")
class Other extends PlexusModel {
  @syncing
  accessor value!: number;
}

@syncing("AtomicFoo")
class Foo extends PlexusModel {
  @syncing
  accessor count!: number;

  @syncing.child.set
  accessor bars!: Set<Bar>;

  // A routed value-map — its mutations flow through the deferred buffer like every
  // other kind, so an atomic body collapses them into the single flush transaction.
  @syncing.map
  accessor meta!: Map<string, number>;

  // A routed VALUE list — array-insert leaf ops with NO child genesis. Isolates the
  // array proxy's overlay/describe/revertOverlay conversion (the riskiest one) from
  // the genesis noise a child-list would add.
  @syncing.list
  accessor tags!: number[];

  // A routed CHILD list — exercises array-insert PLUS per-element genesis + parent edge.
  @syncing.child.list
  accessor items!: Bar[];

  // A routed CHILD map (string keys) — keyed adoption: exercises the per-key meta
  // squash (re-key inside one region) and the rawKey residue sweep.
  @syncing.child.map
  accessor kids!: Map<string, Bar>;

  // A routed CHILD map with ENTITY keys — the key serializes as a reference
  // tuple, so statement-form metas exercise the global serialization path.
  @syncing.child.map
  accessor slots!: Map<Bar, Bar>;

  // A routed VALUE map with ENTITY keys — no child ownership, but describe()
  // still serializes the key at flush: fresh-key genesis must be phase 1, not
  // a write inside the flush transaction.
  @syncing.map
  accessor refs!: Map<Bar, number>;

  /**
   * Atomic body exercising every covered mutation kind:
   *  - val set (`count`)
   *  - read-overlay (reads its own pending writes into `log`)
   *  - add-child + mid-method materialization (`new Bar()`)
   */
  @syncing.action
  doStuff(log: unknown[]): number {
    this.count = 1;
    log.push(this.count); // read own write → 1
    this.bars.add(new Bar({ label: "x" }));
    log.push(this.bars.size); // read own pending add → 1
    this.count = 2;
    log.push(this.count); // read own write → 2
    return this.count; // → 2
  }

  /** Same mutations WITHOUT @syncing.action — baseline for the transaction count. */
  doStuffUnbatched(): void {
    this.count = 1;
    this.bars.add(new Bar({ label: "x" }));
    this.count = 2;
  }

  /** Val-only atomic body — no child materialization (keeps the liminality assertion clean). */
  @syncing.action
  bumpCount(): void {
    this.count = 1;
    this.count = 2;
  }

  /** Value-list push — no genesis; the array-insert leaf ops collapse into the flush. */
  @syncing.action
  pushTags(): void {
    this.tags.push(10);
    this.tags.push(20);
  }

  /** Child-list push — genesis rides its own tx; the array-insert + parent edge ride the batch. */
  @syncing.action
  pushItems(): void {
    this.items.push(new Bar({ label: "a" }));
    this.items.push(new Bar({ label: "b" }));
  }

  /**
   * Opt-in rollback over a VALUE list — exercises the array proxy's revertOverlay,
   * whose snapshot-splice restore is otherwise untested. The pushes overlay into the
   * backing array, then the throw rolls the whole slice back: backing restored, wire pure.
   */
  @syncing.action({ rollbackIf: () => true })
  pushTagsThenThrow(): void {
    this.tags.push(10);
    this.tags.push(20);
    throw new Error("boom");
  }

  /**
   * Opt-in rollback over a CHILD list. By design: a fresh entity's genesis is
   * DEFERRED to flush (phase 1), and rollback skips flush entirely — so the
   * creation never happens. Nothing reaches the doc; the entity's identity was
   * never committed ("don't rely on uuid until we're done").
   */
  @syncing.action({ rollbackIf: () => true })
  pushItemThenThrow(): void {
    this.items.push(new Bar({ label: "ghost" }));
    throw new Error("boom");
  }

  /** Structural detach mid-body — the vehicle for the detach-warning pin below. */
  @syncing.action
  detachFirstBar(): void {
    [...this.bars][0]!.detach();
  }

  /** Trivial routed write, dedicated to the pre-open-transaction pin (warnOnce is per method). */
  @syncing.action
  bumpForTxPin(): void {
    this.count = 41;
  }

  /**
   * Moves an EXISTING child from `bars` (child set) into `items` (child list),
   * reporting what the body observes mid-move — the vehicle for the
   * structural-staleness pin below.
   */
  @syncing.action
  moveFirstBarIntoItems(report: { dualMembership?: boolean; parentFieldDuring?: string | null }): void {
    const bar = [...this.bars][0]!;
    this.items.push(bar);
    report.dualMembership = this.bars.has(bar) && this.items.includes(bar);
    report.parentFieldDuring = bar.parentField;
  }

  // ── Ownership-squash bodies (see the "ownership squash" block below) ──────

  /** Adopt then remove in ONE region: the orphan supersedes the staged adoption. */
  @syncing.action
  squashAddThenRemove(bar: Bar): void {
    this.items.push(bar);
    this.items.splice(this.items.indexOf(bar), 1);
  }

  /** Multi-hop: real home → items (staged) → kids (staged). One net move. */
  @syncing.action
  squashMultiHop(bar: Bar): void {
    this.items.push(bar);
    this.kids.set("dst", bar);
  }

  /** Away and back: kids@"home" (real) → items (staged) → kids@"home" again. */
  @syncing.action
  squashAwayAndBack(bar: Bar): void {
    this.items.push(bar);
    this.kids.set("home", bar);
  }

  /** Map re-key within one region: delete@k1 + set@k2, SAME child. */
  @syncing.action
  squashRekey(bar: Bar): void {
    this.kids.delete("k1");
    this.kids.set("k2", bar);
  }

  /** Lone-set re-key: no delete — the old entry must still vacate. */
  @syncing.action
  squashRekeyLoneSet(bar: Bar): void {
    this.kids.set("k2", bar);
  }

  /** Double-set of a FRESH child: k1 staged, then superseded by k2. */
  @syncing.action
  squashDoubleSet(): Bar {
    const fresh = new Bar({ label: "dbl" });
    this.kids.set("k1", fresh);
    this.kids.set("k2", fresh);
    return fresh;
  }

  /** Stale-source cleanup: move to items, then delete from the now-stale bars. */
  @syncing.action
  squashStaleSourceDelete(bar: Bar): void {
    this.items.push(bar);
    this.bars.delete(bar); // content-only: the orphan's `from` is a stale residual
  }

  /** Reuse from stale: move away, clean the stale source, re-adopt into it. */
  @syncing.action
  squashReuseFromStale(bar: Bar): void {
    this.items.push(bar);
    this.bars.delete(bar);
    this.bars.add(bar); // re-adopt: nets to away-and-back on bars
  }

  /** Same-value indexed reaffirm: stage away to bars, then reaffirm at the STALE items[0]. */
  @syncing.action
  squashReaffirmIndexed(bar: Bar): void {
    this.bars.add(bar); // staged: bar → bars
    this.items[0] = bar; // backing stale (bar physically still at 0) → same-value reaffirm
  }

  /** Ephemeral steal: adopt into a DOC-LESS owner eagerly, then steal into the region. */
  @syncing.action
  squashEphemeralSteal(foo2: Foo): Bar {
    const bar = new Bar({ label: "stolen" });
    foo2.items.push(bar); // doc-less owner → applies eagerly mid-region
    this.items.push(bar); // staged steal from the ephemeral parent
    return bar;
  }

  /** Entity-keyed overwrite: replace the child AT a materialized entity key. */
  @syncing.action
  squashEntityKeyOverwrite(key: Bar): { first: Bar; second: Bar } {
    const first = new Bar({ label: "first" });
    const second = new Bar({ label: "second" });
    this.slots.set(key, first);
    this.slots.set(key, second); // overwrite: first is orphaned having never been real
    return { first, second };
  }

  /** Fresh entity as key: statement time must do NO doc work — key genesis belongs to flush phase 1. */
  @syncing.action
  squashFreshKey(report: { midKey?: unknown; midGet?: boolean }): { key: Bar; value: Bar } {
    const key = new Bar({ label: "fresh-key" });
    const value = new Bar({ label: "keyed-value" });
    this.slots.set(key, value);
    report.midGet = this.slots.get(key) === value; // read own staged write — raw-keyed, no serialization
    report.midKey = value.parentFieldKey; // staged meta round-trips to the key entity mid-region
    return { key, value };
  }

  /** Fresh-key set that rolls back: the key must never have been materialized. */
  @syncing.action({ rollbackIf: () => true })
  squashFreshKeyThrow(): void {
    this.slots.set(new Bar({ label: "phantom-key" }), new Bar({ label: "phantom-value" }));
    throw new Error("boom");
  }

  /** Move an EXISTING child under a fresh key: adopt-over-real with a statement-form meta. */
  @syncing.action
  squashFreshKeyMove(bar: Bar): Bar {
    const key = new Bar({ label: "move-key" });
    this.slots.set(key, bar);
    return key;
  }

  /** Fresh-key set then delete: nets to no entry; the key still materializes (eager parity). */
  @syncing.action
  squashFreshKeySetThenDelete(): Bar {
    const key = new Bar({ label: "transient-key" });
    this.slots.set(key, new Bar({ label: "transient-value" }));
    this.slots.delete(key);
    return key;
  }

  /** Inner slice sets a fresh key then throws; its rollback must unwind the key's would-be genesis too. */
  @syncing.action({ rollbackIf: () => true })
  squashFreshKeyInnerThrow(): void {
    this.slots.set(new Bar({ label: "inner-key" }), new Bar({ label: "inner-value" }));
    throw new Error("inner");
  }

  /** Outer commits AROUND a reverted fresh-key slice — the flush must not resurrect it. */
  @syncing.action
  squashFreshKeyOuterSurvives(): void {
    this.count = 41;
    try {
      this.squashFreshKeyInnerThrow();
    } catch {
      // inner slice reverted — the fresh key's staging unwinds with it
    }
    this.count = 42;
  }

  /** Fresh entity key on a VALUE map: describe() serializes it — genesis must be phase 1, not in-tx. */
  @syncing.action
  squashFreshValueKey(): Bar {
    const key = new Bar({ label: "value-key" });
    this.refs.set(key, 42);
    return key;
  }

  /** Value-map fresh key that rolls back — no genesis, wire pure. */
  @syncing.action({ rollbackIf: () => true })
  squashFreshValueKeyThrow(): void {
    this.refs.set(new Bar({ label: "phantom-value-key" }), 7);
    throw new Error("boom");
  }

  /** Inner slice stages a move then throws; its rollbackIf unwinds the staging. */
  @syncing.action({ rollbackIf: () => true })
  squashInnerMoveThrow(bar: Bar): void {
    this.items.push(bar);
    throw new Error("inner");
  }

  /** Outer catches the inner rollback and reports the RESTORED effective slot. */
  @syncing.action
  squashOuterAfterInnerRevert(bar: Bar, report: { parentFieldAfterRevert?: string | null }): void {
    try {
      this.squashInnerMoveThrow(bar);
    } catch {
      // inner slice reverted — its staged move must be unwound with it
    }
    report.parentFieldAfterRevert = bar.parentField;
  }

  /** Single val set — used to probe the ephemeral (doc-less receiver) path. */
  @syncing.action
  justSet(): void {
    this.count = 7;
  }

  /** Mutates the receiver AND a DIFFERENT doc — the multi-doc case (one tx per doc). */
  @syncing.action
  touchOther(other: Other): void {
    this.count = 3; // receiver's doc → its own single transaction
    other.value = 99; // OTHER doc → its own single transaction
  }

  /**
   * Now that every Plexus mutation KIND is routed, the leak detector is exercised
   * with the canonical unrouted SHAPE it guards against: an eager `maybeTransacting`
   * write on the receiver's (non-liminal) doc DURING the deferred region — exactly
   * what a future not-yet-routed emission site would do internally. The routed
   * writes (`count`, `meta`) still collapse into the single flush; the raw eager
   * write opens its own transaction mid-body and trips the detector.
   */
  @syncing.action
  touchUnrouted(): void {
    this.count = 1; // routed → deferred
    this.meta.set("k", 1); // routed → deferred (batches into the flush)
    maybeTransacting(this.__doc__, () => {
      this.__doc__!.getMap("unrouted-probe").set("probe", 1); // UNROUTED shape → eager tx
    });
  }

  /**
   * Throws after a partial write. DEFAULT = commit-on-crash: the pre-throw write
   * is flushed (matches JS + yjs, which never unwind completed effects).
   */
  @syncing.action
  throwMidway(): void {
    this.count = 1;
    throw new Error("boom");
    // this.count = 2; // unreachable — never buffered
  }

  /** Opt-in rollback: any throw discards the whole batch (wire stays pure). */
  @syncing.action({ rollbackIf: () => true })
  throwWithRollback(): void {
    this.count = 1;
    throw new Error("boom");
  }

  /**
   * Selective rollback: the predicate matches only RangeError. A plain Error
   * commits-on-crash; a RangeError rolls back.
   */
  @syncing.action({ rollbackIf: (error) => error instanceof RangeError })
  throwSelective(kind: "range" | "plain"): void {
    this.count = 5;
    if (kind === "range") throw new RangeError("range");
    throw new Error("plain");
  }

  /**
   * Async body — a COMPILE ERROR. The deferral region is synchronous, so a body
   * that returns a `Promise` is banned at the INPUT: its return makes the `target`
   * parameter collapse to `never`, so it is not an accepted argument. The
   * `@ts-expect-error` below IS the assertion that the ban fires; if the ban ever
   * regressed, tsc would flag the unused expect-error.
   */
  // @ts-expect-error @syncing.action does not accept an async method: its Promise return makes the `target` parameter `never`
  @syncing.action
  async doAsync(): Promise<number> {
    this.count = 4; // synchronous prefix still runs before the promise is returned
    return this.count;
  }

  /**
   * Async GENERATOR — also a COMPILE ERROR. Its `AsyncGenerator` return is an
   * `AsyncIterable`/`AsyncIterator`, so it too makes the `target` parameter `never`
   * and is not an accepted argument: the body runs lazily on iteration, after the
   * region has closed. The `@ts-expect-error` IS the assertion; a regression makes
   * it unused → tsc error.
   */
  // @ts-expect-error @syncing.action does not accept an async generator: its AsyncGenerator return makes the `target` parameter `never`
  @syncing.action
  async *doAsyncGen(): AsyncGenerator<number> {
    this.count = 5;
    yield this.count;
  }

  /**
   * SYNC GENERATOR — also a COMPILE ERROR. A `function*` returns a `Generator`,
   * which is an `Iterator`, so its return makes the `target` parameter `never`. The
   * body runs lazily on the first `.next()`, not when called — so its mutations
   * would miss the synchronous region entirely, exactly the async-generator hazard
   * minus the `await`. `Iterator` (not `Iterable`) is the cut: a body returning a
   * `string`/array/`Map` — `Iterable` but not `Iterator` — stays accepted.
   */
  // @ts-expect-error @syncing.action does not accept a sync generator: its Generator (an Iterator) return makes the `target` parameter `never`
  @syncing.action
  *doSyncGen(): Generator<number> {
    this.count = 6;
    yield this.count;
  }

  /**
   * `(): never` — ACCEPTED, via the ban's explicit escape arm. `[never] extends
   * [X]` is true for ANY `X` (`never` is assignable to everything), so without
   * the leading `[Return] extends [never]` arm in `SyncActionMethod` this
   * always-throwing method would be a false positive of the deferred-delivery
   * ban. This fixture IS the regression guard for that arm: if the escape were
   * dropped, decorating this method would become a tsc error.
   */
  @syncing.action
  doNeverReturn(): never {
    this.count = 7;
    throw new Error("never-return");
  }

  /**
   * `(): any` — REJECTED, on purpose. `[any] extends [X]` is also always true
   * (`any` is bidirectionally assignable), so the ban catches it — and stays:
   * an `any` may BE a Promise, and accepting it would admit sloppily-typed
   * genuinely-async bodies. Annotate the real return type to decorate. The
   * `@ts-expect-error` IS the assertion, mirroring the async fixtures above.
   */
  // @ts-expect-error @syncing.action does not accept an `any` return: it may be a Promise — annotate the real return type
  @syncing.action
  doAny(): any {
    this.count = 8;
    return this.count;
  }
}

describe("@syncing.action method decorator", () => {
  let doc: Y.Doc;
  let plexus: TestPlexus<Foo>;
  let root: Foo;

  // Needed for the notification-suppression assertion: reactions only observe
  // Plexus mutations once the MobX tracking hook is wired up. Idempotent + global.
  beforeAll(() => {
    enableMobXIntegration();
  });

  beforeEach(() => {
    entityClasses.set("AtomicFoo", Foo);
    entityClasses.set("AtomicBar", Bar);
    entityClasses.set("AtomicOther", Other);
    const result = initTestPlexus(
      new Foo({
        count: 0,
        bars: new Set(),
        meta: new Map(),
        tags: [],
        items: [],
        kids: new Map(),
        slots: new Map(),
        refs: new Map(),
      }),
    );
    doc = result.doc;
    plexus = result.plexus;
    root = result.root;
  });

  afterEach(() => {
    entityClasses.clear();
  });

  it("(a) a val-only atomic body collapses into exactly ONE transaction/update", () => {
    const shadow = root.__doc__!; // entities live on the shadow doc
    let shadowUpdates = 0;
    let mainUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    doc.on("update", () => mainUpdates++); // committed write forwards to main

    root.bumpCount(); // count=1; count=2 — no genesis

    // Both writes collapse into the single user-batch transaction.
    expect(shadowUpdates).toBe(1);
    expect(mainUpdates).toBe(1);
  });

  it("(a2) child GENESIS rides its OWN transaction, separate from the user batch", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    let mainUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    doc.on("update", () => mainUpdates++);

    root.doStuff([]); // count=1; add(new Bar); count=2

    // Two transactions: (1) the child's genesis (its own origin — deliberately NOT
    // swallowed into the user's tx) and (2) the user's batch (both count writes +
    // the set entry + parent edge). Genesis-outside-the-user-tx is the whole point
    // of the deferred buffer.
    expect(shadowUpdates).toBe(2);
    expect(mainUpdates).toBe(2);
  });

  it("baseline: WITHOUT @syncing.action the same mutations emit multiple updates", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    root.doStuffUnbatched();

    // Each mutation (and the materialization) opens its own transaction.
    expect(shadowUpdates).toBeGreaterThan(1);
  });

  it("(b) read-overlay: the body reads its own pending writes", () => {
    const log: unknown[] = [];
    // Typed as `number` on purpose: a compile-time guard that the input-side async
    // ban preserved return-type fidelity. The ban poisons the whole `target`
    // parameter to `never` for async returns, with the clean `ActionMethod` as the
    // conditional's FALSE branch — so `Return` still infers from a naked function
    // type. If that regressed to widening (`=> unknown`), this assignment fails tsc.
    const returned: number = root.doStuff(log);

    expect(log).toEqual([1, 1, 2]); // count=1, bars.size=1, count=2 — all read mid-transaction
    expect(returned).toBe(2);
  });

  it("(b2) mid-body structural staleness is SPLIT: content is stale (dual membership) while back-pointers answer with the effective destination", () => {
    // Eager oracle first: performed bare, the move detaches immediately —
    // single membership at every observable moment.
    const eager = initTestPlexus(new Foo({ count: 0, bars: new Set(), meta: new Map(), tags: [], items: [] })).root;
    const ebar = new Bar({ label: "mover" });
    eager.bars.add(ebar);
    eager.items.push(ebar);
    expect(eager.bars.has(ebar)).toBe(false);
    expect(eager.items.includes(ebar)).toBe(true);
    expect(ebar.parentField).toBe("items");

    // The SAME move inside an action. Ownership is squashed per entity and
    // settled at flush, so mid-body the two views deliberately diverge in
    // OPPOSITE directions. Content choreography (sweep the source mirror) is
    // flush-time by design: running it in the overlay would mutate the SOURCE
    // collection's mirror before the action is known to commit, and rollback
    // could no longer restore the source from the op's own snapshot (the op
    // only knows its destination). Back-pointers carry no such rollback
    // burden — they are staged-aware and answer with the EFFECTIVE slot
    // immediately. Pinned here so neither half regresses silently into "bug":
    // during the body the child appears in BOTH collections, yet its
    // back-pointer already names the destination.
    const bar = new Bar({ label: "mover" });
    root.bars.add(bar);
    const report: { dualMembership?: boolean; parentFieldDuring?: string | null } = {};
    root.moveFirstBarIntoItems(report);

    expect(report.dualMembership).toBe(true); // stale: source mirror not yet swept
    expect(report.parentFieldDuring).toBe("items"); // effective: last staged assignment wins

    // After flush: identical to the eager oracle.
    expect(root.bars.has(bar)).toBe(false);
    expect(root.items.includes(bar)).toBe(true);
    expect(bar.parentField).toBe("items");
  });

  it("(c) final materialized state is correct and reaches the main doc", () => {
    root.doStuff([]);

    expect(root.count).toBe(2);
    expect(root.bars.size).toBe(1);
    const [bar] = [...root.bars];
    expect(bar.label).toBe("x");
    // The bar was materialized (uuid resolves) and committed.
    expect(() => bar.uuid).not.toThrow();
    expect(plexus.loadEntity(bar.uuid)).toBeTruthy();
  });

  it("(array) a value-list push inside an atomic body collapses into ONE transaction", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    root.pushTags(); // tags.push(10); tags.push(20) — no genesis

    // Both array-insert leaf ops (and the field's Y.Array creation) collapse into the
    // single user-batch transaction; a value list adds no separate genesis tx.
    expect(shadowUpdates).toBe(1);
    expect([...root.tags]).toEqual([10, 20]);
  });

  it("(array) a child-list push materializes each element and lands in order", () => {
    root.pushItems(); // items.push(new Bar a); items.push(new Bar b)

    expect(root.items.length).toBe(2);
    expect(root.items.map((bar) => bar.label)).toEqual(["a", "b"]);
    for (const bar of root.items) {
      // Each element was materialized (uuid resolves) and committed.
      expect(() => bar.uuid).not.toThrow();
      expect(plexus.loadEntity(bar.uuid)).toBeTruthy();
    }
  });

  it("(array) rollbackIf reverts a value-list push via revertOverlay's snapshot restore", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    expect(() => root.pushTagsThenThrow()).toThrow("boom");

    // Predicate matched → the buffered array-inserts were DISCARDED (never reached the
    // wire) and the overlay was inversed back to the pre-body array via snapshot-splice.
    expect([...root.tags]).toEqual([]);
    expect(shadowUpdates).toBe(0);
  });

  it("(array) rollbackIf on a child-list push undoes the entity CREATION entirely — no genesis, wire pure", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    expect(() => root.pushItemThenThrow()).toThrow("boom");

    // By design: genesis is deferred to flush phase 1, and rollback skips flush entirely.
    // So the fresh entity is NEVER materialized — zero shadow updates means not even the
    // genesis transaction fired. The overlay was inversed, so the list is empty again.
    // Identity was never committed → "don't rely on uuid until we're done" holds by construction.
    expect(root.items.length).toBe(0);
    expect(shadowUpdates).toBe(0);
  });

  it("one undo step reverts the whole atomic batch", () => {
    root.doStuff([]);
    expect(root.count).toBe(2);
    expect(root.bars.size).toBe(1);

    plexus.undo();

    expect(root.count).toBe(0);
    expect(root.bars.size).toBe(0);
  });

  it("re-entrancy: a nested @syncing.action call still yields ONE transaction", () => {
    @syncing("AtomicNested")
    class Nested extends PlexusModel {
      @syncing accessor a!: number;
      @syncing accessor b!: number;

      @syncing.action
      outer(): void {
        this.a = 1;
        this.inner();
        this.a = 2;
      }

      @syncing.action
      inner(): void {
        this.b = 1;
        this.b = 2;
      }
    }
    entityClasses.set("AtomicNested", Nested);

    const { root: nestedRoot } = initTestPlexus(new Nested({ a: 0, b: 0 }));
    const shadow = nestedRoot.__doc__!;
    let updates = 0;
    shadow.on("update", () => updates++);

    nestedRoot.outer();

    expect(updates).toBe(1);
    expect(nestedRoot.a).toBe(2);
    expect(nestedRoot.b).toBe(2);
  });

  it("nested cross-doc: the OUTERMOST action fires EVERY doc's transaction in one burst (structural all-or-nothing, not 2-phase)", () => {
    // Outer touches its own doc (A); the nested inner touches a DIFFERENT doc (B)
    // as well as doc A. If the inner flushed at ITS boundary, doc B's update would
    // land BEFORE "inner-returned". It must not: the stack-topmost action owns the
    // single flush, so BOTH docs' transactions burst only after the whole outermost
    // body has finished. This is the structural all-or-nothing guarantee — the only
    // way to observe a cross-doc partial is a hard process crash mid-burst (no
    // 2-phase commit), which no synchronous control flow can produce.
    @syncing("AtomicOutermost")
    class Outermost extends PlexusModel {
      @syncing accessor a!: number;

      @syncing.action
      outer(other: Other, log: string[]): void {
        this.a = 1;
        this.inner(other);
        log.push("inner-returned");
        this.a = 2;
        log.push("outer-body-end");
      }

      @syncing.action
      inner(other: Other): void {
        other.value = 99; // DIFFERENT doc (B) → must defer to the OUTERMOST flush
        this.a = 5; // doc A
      }
    }
    entityClasses.set("AtomicOutermost", Outermost);

    const { root: om } = initTestPlexus(new Outermost({ a: 0 }));
    const { root: otherRoot } = initTestPlexus(new Other({ value: 0 }));
    const docA = om.__doc__!;
    const docB = otherRoot.__doc__!;

    const log: string[] = [];
    docA.on("update", () => log.push("A-update"));
    docB.on("update", () => log.push("B-update"));

    om.outer(otherRoot, log);

    // Both doc updates fire AFTER the whole body completed — no transaction opened
    // at the inner boundary or mid-outer. Docs burst in first-touched order (A, B).
    expect(log).toEqual(["inner-returned", "outer-body-end", "A-update", "B-update"]);
    // Exactly one transaction per doc (per-doc atomicity; three A-writes collapse).
    expect(log.filter((e) => e === "A-update")).toHaveLength(1);
    expect(log.filter((e) => e === "B-update")).toHaveLength(1);
    // Final committed state on both docs.
    expect(om.a).toBe(2);
    expect(otherRoot.value).toBe(99);
  });

  // ── OUT-OF-ENVELOPE: loud-but-correct boundaries ──────────────────────────

  it("async body is a COMPILE error, not a runtime warning", async () => {
    // The ban is enforced by tsc at the INPUT — the Promise return collapses the
    // `target` parameter to `never`; see the `@ts-expect-error` on `doAsync`'s
    // decorator. At runtime the wrapper still runs the synchronous prefix; there is
    // no runtime thenable warning any more.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = root.doAsync();

    await expect(promise).resolves.toBe(4);
    expect(root.count).toBe(4);

    const warnedThenable = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("thenable"),
    );
    expect(warnedThenable).toBe(false);

    warnSpy.mockRestore();
  });

  it("ephemeral receiver (null __doc__): the write lands eagerly, no warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ephemeral = new Foo({ count: 0, bars: new Set() });
    expect(ephemeral.__doc__).toBeNull(); // not materialized into any tree

    ephemeral.justSet();

    // The write lands in backing storage; with no doc there is simply nothing to
    // defer into, so the region handles it gracefully — no warning.
    expect(ephemeral.count).toBe(7);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("unrouted mutation kind is detected: warns once AND is NOT batched", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    root.touchUnrouted();

    // The routed val/map sets collapse into the flush's single transaction; the
    // unrouted eager write opened its OWN transaction during the body → >1 update.
    expect(shadowUpdates).toBeGreaterThan(1);
    expect(root.count).toBe(1);
    expect(root.meta.get("k")).toBe(1);
    expect(shadow.getMap("unrouted-probe").get("probe")).toBe(1);

    const warnedUnrouted = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("NOT yet routed through the action buffer"),
    );
    expect(warnedUnrouted).toBe(true);

    warnSpy.mockRestore();
  });

  it("multi-doc: each doc the body mutates gets its OWN single transaction", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { root: otherRoot } = initTestPlexus(new Other({ value: 0 }));
    const receiverShadow = root.__doc__!;
    const otherShadow = otherRoot.__doc__!;

    let receiverUpdates = 0;
    let otherUpdates = 0;
    receiverShadow.on("update", () => receiverUpdates++);
    otherShadow.on("update", () => otherUpdates++);

    root.touchOther(otherRoot);

    // The region groups buffered writes by doc and bursts one transaction per doc:
    // the receiver's `count` write and the other doc's `value` write each collapse
    // into a single, SEPARATE transaction. Atomicity is per-doc (yjs has no
    // cross-doc transaction); both writes are routed (val set), so nothing leaks.
    expect(receiverUpdates).toBe(1);
    expect(otherUpdates).toBe(1);
    expect(root.count).toBe(3);
    expect(otherRoot.value).toBe(99);

    // Multi-doc is supported now — no out-of-envelope warning.
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("structural detach inside the body warns AND applies immediately (wire-impure)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bar = new Bar({ label: "d" });
    root.bars.add(bar); // eager add, outside any action
    expect(bar.parent).toBe(root);

    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    root.detachFirstBar();

    // detach() is structural, not routed: #emancipate cleared the yjs parent
    // attributes RAW during the body (its own implicit transaction → mid-body
    // wire activity), while the container removal routed through the set proxy
    // and deferred to the flush. Hence >1 update — the incoherence the warning
    // is about.
    expect(shadowUpdates).toBeGreaterThan(1);
    expect(bar.parent).toBeNull();
    expect(root.bars.has(bar)).toBe(false);

    const warnedDetach = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("structurally detached during an action body"),
    );
    expect(warnedDetach).toBe(true);

    warnSpy.mockRestore();
  });

  it("detach OUTSIDE an action stays silent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bar = new Bar({ label: "d" });
    root.bars.add(bar);

    bar.detach();

    expect(bar.parent).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("action called inside plexus.transact() warns: the flush cannot own its boundaries", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    plexus.transact(() => {
      root.bumpForTxPin();
    });

    // The batch still applies — only the envelope guarantees degrade (the
    // flush's per-doc transactions nested into the caller's open transaction).
    expect(root.count).toBe(41);

    const warnedPreOpen = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("already-open transaction"),
    );
    expect(warnedPreOpen).toBe(true);

    warnSpy.mockRestore();
  });

  // ── BOUNDARY BEHAVIOR: asserted, not changed ──────────────────────────────

  it("liminality: an atomic method during a session stays in PREVIEW (not committed to main)", () => {
    let mainUpdates = 0;
    doc.on("update", () => mainUpdates++); // main = the committed store

    plexus.enterLiminality();
    root.bumpCount();

    // Preview reflects the writes…
    expect(root.count).toBe(2);
    // …but nothing was forwarded to main (held on the shadow as preview).
    expect(mainUpdates).toBe(0);

    plexus.revertLiminality();

    // Preview discarded → back to the pre-liminal state; main never saw it.
    expect(root.count).toBe(0);
    expect(mainUpdates).toBe(0);
  });

  it("liminality: committing the session lands the atomic batch on main", () => {
    let mainUpdates = 0;
    doc.on("update", () => mainUpdates++);

    plexus.enterLiminality();
    root.bumpCount();
    expect(mainUpdates).toBe(0); // still preview

    plexus.commitLiminality();

    // Now the committed delta reaches main.
    expect(root.count).toBe(2);
    expect(mainUpdates).toBeGreaterThan(0);
  });

  it("throw mid-body COMMITS-ON-CRASH by default: the pre-throw write is flushed", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    expect(() => root.throwMidway()).toThrow("boom");

    // Default (no rollbackIf) matches JS + yjs: the write buffered before the throw
    // is flushed as one transaction, then the error rethrows.
    expect(root.count).toBe(1);
    expect(shadowUpdates).toBe(1);
  });

  it("`(): never` body (always-throws) is accepted by the ban's escape arm and commits-on-crash", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    expect(() => root.doNeverReturn()).toThrow("never-return");

    // The escape arm admitted the method (see the fixture's docstring); at
    // runtime it behaves as any other throwing body: default commit-on-crash.
    expect(root.count).toBe(7);
    expect(shadowUpdates).toBe(1);
  });

  it("@syncing.action({ rollbackIf }) discards the batch: wire stays pure, mirror restored", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    const notify = vi.fn();
    const dispose = reaction(() => root.count, notify);

    expect(() => root.throwWithRollback()).toThrow("boom");

    // Predicate matched → the yjs write was DISCARDED (never reached the wire) and
    // the overlay was inversed back to the pre-body value.
    expect(root.count).toBe(0);
    expect(shadowUpdates).toBe(0);
    // Net-zero change → the reaction sees nothing.
    expect(notify).not.toHaveBeenCalled();

    dispose();
  });

  it("rollbackIf is SELECTIVE: a matching error rolls back, a non-matching error commits", () => {
    // Non-matching (plain Error) → commit-on-crash keeps the write.
    expect(() => root.throwSelective("plain")).toThrow("plain");
    expect(root.count).toBe(5);

    // Fresh receiver: matching (RangeError) → rollback discards the write.
    const { root: root2 } = initTestPlexus(new Foo({ count: 0, bars: new Set(), meta: new Map() }));
    expect(() => root2.throwSelective("range")).toThrow("range");
    expect(root2.count).toBe(0);
  });

  it("a rollbackIf that ITSELF throws settles as commit-on-crash: buffer flushed, predicate's error propagates", () => {
    @syncing("AtomicBadPredicate")
    class BadPredicate extends PlexusModel {
      @syncing accessor n!: number;

      @syncing.action({
        rollbackIf: () => {
          throw new Error("predicate-broke");
        },
      })
      write(): void {
        this.n = 1;
        throw new Error("body-boom");
      }
    }
    entityClasses.set("AtomicBadPredicate", BadPredicate);

    const { root: bp } = initTestPlexus(new BadPredicate({ n: 0 }));
    const shadow = bp.__doc__!;
    let updates = 0;
    shadow.on("update", () => updates++);

    // Per JS catch semantics the predicate's error replaces the body's…
    expect(() => bp.write()).toThrow("predicate-broke");
    // …but the region SETTLED as commit-on-crash: the buffered write reached yjs.
    // An abandoned buffer would leave the mirror silently ahead of the wire.
    expect(bp.n).toBe(1);
    expect(updates).toBe(1);
  });

  it("liminality + rollbackIf: the liminal write applies INSTANTLY, is NOT rolled back, and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let mainUpdates = 0;
    doc.on("update", () => mainUpdates++);

    plexus.enterLiminality();

    // `throwWithRollback` sets count=1 then throws; its predicate asks for rollback.
    // But the receiver's doc is liminal, so the write applied INSTANTLY (the preview
    // shadow owns atomicity) rather than being buffered — the region cannot discard it.
    expect(() => root.throwWithRollback()).toThrow("boom");

    // The instant write survives the rollback (it was never buffered)…
    expect(root.count).toBe(1);
    // …stayed in the preview (never forwarded to main)…
    expect(mainUpdates).toBe(0);
    // …and the rollback loudly reported that it could not revert a liminal effect.
    const warnedLiminal = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("liminal"),
    );
    expect(warnedLiminal).toBe(true);

    plexus.revertLiminality();
    warnSpy.mockRestore();
  });

  it("nested: an inner rollbackIf reverts ONLY its slice; the outer batch still commits", () => {
    @syncing("AtomicSavepoint")
    class Savepoint extends PlexusModel {
      @syncing accessor a!: number;
      @syncing accessor b!: number;

      // Outer writes `a`, calls a rolling-back inner that writes+throws `b`, catches
      // it, then writes `a` again. Commit-on-crash for the outer; the inner's slice
      // is reverted by its own predicate.
      @syncing.action
      outer(): void {
        this.a = 1;
        try {
          this.innerRollback();
        } catch {
          // swallow — the outer continues and still commits its own writes
        }
        this.a = 2;
      }

      @syncing.action({ rollbackIf: () => true })
      innerRollback(): void {
        this.b = 9;
        throw new Error("inner");
      }
    }
    entityClasses.set("AtomicSavepoint", Savepoint);

    const { root: sp } = initTestPlexus(new Savepoint({ a: 0, b: 0 }));
    const shadow = sp.__doc__!;
    let updates = 0;
    shadow.on("update", () => updates++);

    sp.outer();

    // Outer committed once; the inner's `b` write was reverted out of the shared buffer.
    expect(updates).toBe(1);
    expect(sp.a).toBe(2);
    expect(sp.b).toBe(0);
  });

  // ── Ownership squash ────────────────────────────────────────────────────────
  // Parenting is a first-class region concern: sites declare ownership FACTS
  // (adopt / orphan-with-from), the region squashes them to the LAST assignment
  // per child, and flush settles each child ONCE — sweeping displaced residue,
  // then emancipate+inform (or orphanize) against the real pointers.
  describe("ownership squash", () => {
    it("adopt-then-remove nets to an orphan: the region's own removal supersedes its adoption", () => {
      const bar = new Bar({ label: "transient" });
      root.bars.add(bar); // real home
      root.squashAddThenRemove(bar);

      expect(bar.parent).toBe(null); // final staged state: orphan
      expect(root.bars.has(bar)).toBe(false); // emancipated from the REAL home
      expect(root.items.length).toBe(0); // push + splice netted to nothing
    });

    it("multi-hop squashes to ONE net move — no ghost membership in the intermediate collection", () => {
      const bar = new Bar({ label: "hopper" });
      root.bars.add(bar);
      const shadow = root.__doc__!;
      let updates = 0;
      shadow.on("update", () => updates++);

      root.squashMultiHop(bar); // bars (real) → items (staged) → kids@dst (staged)

      expect(root.kids.get("dst")).toBe(bar);
      expect(root.items.length).toBe(0); // the displaced items insert was swept
      expect(root.bars.size).toBe(0); // emancipated from the real home
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("kids");
      expect(updates).toBe(1); // one flush tx; no genesis (bar pre-materialized)
    });

    it("away-and-back nets to zero: the final slot IS the real slot, so nothing settles", () => {
      const bar = new Bar({ label: "boomerang" });
      root.kids.set("home", bar); // real home: kids@home

      root.squashAwayAndBack(bar); // → items (staged) → kids@home again

      expect(root.kids.get("home")).toBe(bar); // content untouched
      expect(root.items.length).toBe(0); // the ghost insert was swept
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("kids");
    });

    it("savepoint: an inner rollback unwinds its staged moves — the outer body sees the real slot again", () => {
      const bar = new Bar({ label: "kept" });
      root.bars.add(bar);
      const report: { parentFieldAfterRevert?: string | null } = {};

      root.squashOuterAfterInnerRevert(bar, report);

      expect(report.parentFieldAfterRevert).toBe("bars"); // staging unwound with the slice
      expect(root.bars.has(bar)).toBe(true);
      expect(root.items.length).toBe(0);
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("bars");
    });

    it("same-value indexed reaffirm wins over an earlier staged move (stale backing)", () => {
      const bar = new Bar({ label: "reaffirmed" });
      root.items[0] = bar; // real home: items[0]

      root.squashReaffirmIndexed(bar);

      expect(root.items[0]).toBe(bar); // last assignment wins
      expect(root.bars.has(bar)).toBe(false); // the earlier staged add was superseded
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("items");
    });

    it("ephemeral steal: an eagerly-adopted child is stolen into the region's doc-ful destination", () => {
      const foo2 = new Foo({
        count: 0,
        bars: new Set(),
        meta: new Map(),
        tags: [],
        items: [],
        kids: new Map(),
        slots: new Map(),
      }); // never initTestPlexus'd → doc-less

      const bar = root.squashEphemeralSteal(foo2);

      expect(foo2.items.length).toBe(0); // emancipated from the ephemeral parent
      expect(root.items.includes(bar)).toBe(true);
      expect(bar.parent).toBe(root);
      expect(() => bar.uuid).not.toThrow(); // materialized into root's doc at flush
    });

    it("map re-key (delete@k1 + set@k2) moves the entry: old key gone, new key holds the child, pointers follow", () => {
      const bar = new Bar({ label: "keyed" });
      root.kids.set("k1", bar); // real home: kids@k1

      root.squashRekey(bar);

      expect(root.kids.has("k1")).toBe(false);
      expect(root.kids.get("k2")).toBe(bar);
      expect(root.kids.size).toBe(1);
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("kids");
    });

    it("map re-key (lone set) vacates the old key without an explicit delete", () => {
      const bar = new Bar({ label: "keyed" });
      root.kids.set("k1", bar);

      root.squashRekeyLoneSet(bar);

      expect(root.kids.has("k1")).toBe(false); // single-parent: the old entry vacated
      expect(root.kids.get("k2")).toBe(bar);
      expect(root.kids.size).toBe(1);
      expect(bar.parentField).toBe("kids");
    });

    it("double-set of a fresh child sweeps the superseded key: single membership at flush", () => {
      const fresh = root.squashDoubleSet();

      expect(root.kids.has("k1")).toBe(false); // the displaced k1 insert was swept
      expect(root.kids.get("k2")).toBe(fresh);
      expect(root.kids.size).toBe(1);
      expect(fresh.parent).toBe(root);
      expect(fresh.parentField).toBe("kids");
    });

    it("stale-source delete is content-only: it does NOT orphan the child from its effective home", () => {
      const bar = new Bar({ label: "moved" });
      root.bars.add(bar);

      root.squashStaleSourceDelete(bar); // items.push, then bars.delete (stale residual)

      expect(root.bars.size).toBe(0);
      expect(root.items.includes(bar)).toBe(true);
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("items"); // the stale delete did not null the move
    });

    it("reuse from stale: away, cleanup, re-adopt — nets to the original slot", () => {
      const bar = new Bar({ label: "returner" });
      root.bars.add(bar);

      root.squashReuseFromStale(bar);

      expect(root.bars.has(bar)).toBe(true);
      expect(root.items.length).toBe(0);
      expect(bar.parent).toBe(root);
      expect(bar.parentField).toBe("bars");
    });

    it("entity-keyed map: overwrite at a materialized entity key — loser orphaned, winner resident", () => {
      const key = new Bar({ label: "the-key" });
      root.bars.add(key); // materialize + anchor the key entity

      const { first, second } = root.squashEntityKeyOverwrite(key);

      expect(root.slots.get(key)).toBe(second);
      expect(root.slots.size).toBe(1);
      expect(first.parent).toBe(null); // staged adopt superseded by the overwrite's orphan
      expect(second.parent).toBe(root);
      expect(second.parentField).toBe("slots");
    });

    it("a cross-statement cycle is caught AT the statement, judged against EFFECTIVE ownership; prior statements commit-on-crash", () => {
      @syncing("AtomicTreeNode")
      class TreeNode extends PlexusModel {
        @syncing accessor name!: string;
        @syncing.child.list accessor children!: TreeNode[];

        @syncing.action
        reparentThenCycle(a: TreeNode, b: TreeNode): void {
          a.children.push(b); // b: tree → a (staged)
          b.children.push(a); // a under b, whose EFFECTIVE ancestor is already a → cycle NOW
        }
      }
      entityClasses.set("AtomicTreeNode", TreeNode);

      const { root: tree } = initTestPlexus(new TreeNode({ name: "t", children: [] }));
      const a = new TreeNode({ name: "a", children: [] });
      const b = new TreeNode({ name: "b", children: [] });
      tree.children.push(a);
      tree.children.push(b);

      expect(() => tree.reparentThenCycle(a, b)).toThrow(PlexusCycleError);

      // Commit-on-crash (default): statement 1 flushed; the cycle statement never buffered.
      expect(b.parent).toBe(a);
      expect(a.children.includes(b)).toBe(true);
      expect(tree.children.includes(b)).toBe(false);
    });

    describe("fresh entity keys", () => {
      it("fresh key commits: genesis lands in flush phase 1 with its own origin — key materialized, entry present", () => {
        const shadow = root.__doc__!;
        let updates = 0;
        shadow.on("update", () => updates++);
        const report: { midKey?: unknown; midGet?: boolean } = {};

        const { key, value } = root.squashFreshKey(report);

        expect(report.midGet).toBe(true); // raw-keyed overlay read
        expect(report.midKey).toBe(key); // staged meta round-trips to the key entity mid-region
        expect(root.slots.get(key)).toBe(value);
        expect(value.parent).toBe(root);
        expect(value.parentField).toBe("slots");
        expect(value.parentFieldKey).toBe(key); // settled meta (global form) round-trips too
        expect(() => key.uuid).not.toThrow();
        expect(plexus.loadEntity(key.uuid)).toBeTruthy(); // really in the doc, not just id-minted
        // key genesis + value genesis (phase 1, own origins) + ONE flush tx
        expect(updates).toBe(3);
      });

      it("fresh key rollback: statement time did NO doc work — no genesis, wire pure", () => {
        const shadow = root.__doc__!;
        let updates = 0;
        shadow.on("update", () => updates++);

        expect(() => root.squashFreshKeyThrow()).toThrow("boom");

        // Not even the key's genesis fired: "don't rely on uuid until we're
        // done" holds for KEYS the same way it holds for child values.
        expect(updates).toBe(0);
        expect(root.slots.size).toBe(0);
      });

      it("fresh key adopts an EXISTING child: the move settles under a key that is born at flush", () => {
        const bar = new Bar({ label: "mover" });
        root.bars.add(bar);

        const key = root.squashFreshKeyMove(bar);

        expect(root.slots.get(key)).toBe(bar);
        expect(root.bars.size).toBe(0); // emancipated from the real home
        expect(bar.parentField).toBe("slots");
        expect(bar.parentFieldKey).toBe(key);
        expect(plexus.loadEntity(key.uuid)).toBeTruthy();
      });

      it("fresh key set-then-delete nets to no entry; the key still materializes (eager parity)", () => {
        const key = root.squashFreshKeySetThenDelete();

        expect(root.slots.size).toBe(0);
        // Parity with the eager path, which also materializes the key of a
        // subsequently-deleted entry: content ops replay both statements.
        expect(() => key.uuid).not.toThrow();
        expect(plexus.loadEntity(key.uuid)).toBeTruthy();
      });

      it("savepoint: a reverted fresh-key slice leaves no trace even though the region commits", () => {
        const shadow = root.__doc__!;
        let updates = 0;
        shadow.on("update", () => updates++);

        root.squashFreshKeyOuterSurvives();

        expect(root.count).toBe(42); // outer writes flushed
        expect(root.slots.size).toBe(0); // inner slice fully unwound
        expect(updates).toBe(1); // just the outer flush — no stray genesis from the reverted slice
      });

      it("VALUE-map fresh entity key: genesis is phase 1 (own origin), not inside the flush transaction", () => {
        const shadow = root.__doc__!;
        let updates = 0;
        shadow.on("update", () => updates++);

        const key = root.squashFreshValueKey();

        expect(root.refs.get(key)).toBe(42);
        expect(plexus.loadEntity(key.uuid)).toBeTruthy();
        // Genesis in its own transaction (phase 1) + ONE flush tx. A single
        // update would mean the key was minted INSIDE the user transaction —
        // wrong origin, wrong undo granularity.
        expect(updates).toBe(2);
      });

      it("VALUE-map fresh key rollback: wire pure, identity never minted", () => {
        const shadow = root.__doc__!;
        let updates = 0;
        shadow.on("update", () => updates++);

        expect(() => root.squashFreshValueKeyThrow()).toThrow("boom");

        expect(updates).toBe(0);
        expect(root.refs.size).toBe(0);
      });
    });
  });
});
