import { reaction } from "mobx";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
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

  /**
   * Atomic body exercising every covered mutation kind:
   *  - val set (`count`)
   *  - read-overlay (reads its own pending writes into `log`)
   *  - add-child + mid-method materialization (`new Bar()`)
   */
  @syncing.atomic
  doStuff(log: unknown[]): number {
    this.count = 1;
    log.push(this.count); // read own write → 1
    this.bars.add(new Bar({ label: "x" }));
    log.push(this.bars.size); // read own pending add → 1
    this.count = 2;
    log.push(this.count); // read own write → 2
    return this.count; // → 2
  }

  /** Same mutations WITHOUT @syncing.atomic — baseline for the transaction count. */
  doStuffUnbatched(): void {
    this.count = 1;
    this.bars.add(new Bar({ label: "x" }));
    this.count = 2;
  }

  /** Val-only atomic body — no child materialization (keeps the liminality assertion clean). */
  @syncing.atomic
  bumpCount(): void {
    this.count = 1;
    this.count = 2;
  }

  /** Single val set — used to probe the ephemeral (doc-less receiver) path. */
  @syncing.atomic
  justSet(): void {
    this.count = 7;
  }

  /** Mutates the receiver AND a DIFFERENT doc — the multi-doc case (one tx per doc). */
  @syncing.atomic
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
  @syncing.atomic
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
  @syncing.atomic
  throwMidway(): void {
    this.count = 1;
    throw new Error("boom");
    // this.count = 2; // unreachable — never buffered
  }

  /** Opt-in rollback: any throw discards the whole batch (wire stays pure). */
  @syncing.atomic({ rollbackIf: () => true })
  throwWithRollback(): void {
    this.count = 1;
    throw new Error("boom");
  }

  /**
   * Selective rollback: the predicate matches only RangeError. A plain Error
   * commits-on-crash; a RangeError rolls back.
   */
  @syncing.atomic({ rollbackIf: (error) => error instanceof RangeError })
  throwSelective(kind: "range" | "plain"): void {
    this.count = 5;
    if (kind === "range") throw new RangeError("range");
    throw new Error("plain");
  }

  /**
   * Async body — a COMPILE ERROR. The deferral region is synchronous, so an async
   * body is banned at the type level via the `AsyncMethodNotAllowed` brand. The
   * `@ts-expect-error` below IS the assertion that the ban fires; if the ban ever
   * regressed, tsc would flag the unused expect-error.
   */
  // @ts-expect-error @syncing.atomic cannot decorate an async method (AsyncMethodNotAllowed)
  @syncing.atomic
  async doAsync(): Promise<number> {
    this.count = 4; // synchronous prefix still runs before the promise is returned
    return this.count;
  }
}

describe("@syncing.atomic method decorator", () => {
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
    const result = initTestPlexus(new Foo({ count: 0, bars: new Set(), meta: new Map() }));
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

  it("baseline: WITHOUT @syncing.atomic the same mutations emit multiple updates", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    root.doStuffUnbatched();

    // Each mutation (and the materialization) opens its own transaction.
    expect(shadowUpdates).toBeGreaterThan(1);
  });

  it("(b) read-overlay: the body reads its own pending writes", () => {
    const log: unknown[] = [];
    const returned = root.doStuff(log);

    expect(log).toEqual([1, 1, 2]); // count=1, bars.size=1, count=2 — all read mid-transaction
    expect(returned).toBe(2);
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

  it("one undo step reverts the whole atomic batch", () => {
    root.doStuff([]);
    expect(root.count).toBe(2);
    expect(root.bars.size).toBe(1);

    plexus.undo();

    expect(root.count).toBe(0);
    expect(root.bars.size).toBe(0);
  });

  it("re-entrancy: a nested @syncing.atomic call still yields ONE transaction", () => {
    @syncing("AtomicNested")
    class Nested extends PlexusModel {
      @syncing accessor a!: number;
      @syncing accessor b!: number;

      @syncing.atomic
      outer(): void {
        this.a = 1;
        this.inner();
        this.a = 2;
      }

      @syncing.atomic
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

  // ── OUT-OF-ENVELOPE: loud-but-correct boundaries ──────────────────────────

  it("async body is a COMPILE error, not a runtime warning", async () => {
    // The ban is enforced by tsc via the `AsyncMethodNotAllowed` brand — see the
    // `@ts-expect-error` on `doAsync`'s decorator. At runtime the wrapper still runs
    // the synchronous prefix; there is no runtime thenable warning any more.
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
      ([message]) => typeof message === "string" && message.includes("NOT yet routed through the atomic buffer"),
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

  it("@syncing.atomic({ rollbackIf }) discards the batch: wire stays pure, mirror restored", () => {
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
      @syncing.atomic
      outer(): void {
        this.a = 1;
        try {
          this.innerRollback();
        } catch {
          // swallow — the outer continues and still commits its own writes
        }
        this.a = 2;
      }

      @syncing.atomic({ rollbackIf: () => true })
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
});
