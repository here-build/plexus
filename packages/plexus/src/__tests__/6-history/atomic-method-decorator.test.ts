import { reaction } from "mobx";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { entityClasses } from "../../globals.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus, type TestPlexus } from "../_helpers/test-plexus.js";

// A child entity materialized mid-method by the atomic body.
@syncing("AtomicBar")
class Bar extends PlexusModel {
  @syncing
  accessor label!: string;
}

// Lives on its OWN plexus/doc — used to exercise the cross-doc out-of-envelope path.
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

  // A value collection whose mutations are NOT routed through the atomic buffer
  // yet — used to exercise the unrouted-mutation-kind boundary detector.
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

  /** Mutates the receiver AND a DIFFERENT doc — the cross-doc out-of-envelope case. */
  @syncing.atomic
  touchOther(other: Other): void {
    this.count = 3; // receiver's doc → batched
    other.value = 99; // OTHER doc → its own transaction, NOT batched
  }

  /**
   * Mutates via an UNROUTED kind (`Map.set`) — not wired into the deferred buffer,
   * so it writes yjs eagerly during the body and trips the leak detector.
   */
  @syncing.atomic
  touchUnrouted(): void {
    this.count = 1; // routed → deferred
    this.meta.set("k", 1); // UNROUTED → eager yjs write on the receiver's doc
  }

  /** Throws after a partial write — exercises spec rollback (buffer discarded). */
  @syncing.atomic
  throwMidway(): void {
    this.count = 1;
    throw new Error("boom");
    // this.count = 2; // unreachable — never committed
  }

  /** Async body — batching is lost after the (here, immediate) await; warns. */
  @syncing.atomic
  async doAsync(): Promise<number> {
    this.count = 4; // batched (runs before the function returns its promise)
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

  it("(a) batches N mutations into exactly ONE yjs transaction/update", () => {
    const shadow = root.__doc__!; // entities live on the shadow doc
    let shadowUpdates = 0;
    let mainUpdates = 0;
    shadow.on("update", () => shadowUpdates++);
    doc.on("update", () => mainUpdates++); // committed write forwards to main

    root.doStuff([]);

    // 3 mutations + 1 child materialization, all collapsed into one transaction.
    expect(shadowUpdates).toBe(1);
    expect(mainUpdates).toBe(1);
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

  it("async body warns once that mutations after an await are not batched", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = root.doAsync();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("returned a thenable");

    // The synchronous prefix still ran and was batched.
    await expect(promise).resolves.toBe(4);
    expect(root.count).toBe(4);

    warnSpy.mockRestore();
  });

  it("ephemeral receiver (null __doc__) degrades to no batching and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ephemeral = new Foo({ count: 0, bars: new Set() });
    expect(ephemeral.__doc__).toBeNull(); // not materialized into any tree

    ephemeral.justSet();

    // Still correct — the write lands in backing storage — it just isn't batched.
    expect(ephemeral.count).toBe(7);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("ephemeral");

    warnSpy.mockRestore();
  });

  it("unrouted mutation kind is detected: warns once AND is NOT batched", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    root.touchUnrouted();

    // The routed val set batches into one transaction; the unrouted Map.set opened
    // its OWN eager transaction during the body → two updates, not one.
    expect(shadowUpdates).toBeGreaterThan(1);
    expect(root.count).toBe(1);
    expect(root.meta.get("k")).toBe(1);

    const warnedUnrouted = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("NOT yet routed through the atomic buffer"),
    );
    expect(warnedUnrouted).toBe(true);

    warnSpy.mockRestore();
  });

  it("cross-doc mutation is NOT batched: warns once AND lands as a separate transaction", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { root: otherRoot } = initTestPlexus(new Other({ value: 0 }));
    const receiverShadow = root.__doc__!;
    const otherShadow = otherRoot.__doc__!;

    let receiverUpdates = 0;
    let otherUpdates = 0;
    receiverShadow.on("update", () => receiverUpdates++);
    otherShadow.on("update", () => otherUpdates++);

    root.touchOther(otherRoot);

    // The receiver's own mutation is collapsed into its single atomic transaction…
    expect(receiverUpdates).toBe(1);
    // …but the other doc opened its OWN transaction — separate, not co-batched.
    expect(otherUpdates).toBe(1);
    expect(root.count).toBe(3);
    expect(otherRoot.value).toBe(99);

    // And the boundary was announced loudly.
    const warnedCrossDoc = warnSpy.mock.calls.some(
      ([message]) => typeof message === "string" && message.includes("single-doc only"),
    );
    expect(warnedCrossDoc).toBe(true);

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

  it("throw mid-body ROLLS BACK: the wire stays pure and the overlay is restored", () => {
    const shadow = root.__doc__!;
    let shadowUpdates = 0;
    shadow.on("update", () => shadowUpdates++);

    const notify = vi.fn();
    const dispose = reaction(() => root.count, notify);

    expect(() => root.throwMidway()).toThrow("boom");

    // Spec rollback: the yjs writes were BUFFERED and discarded on throw, so the
    // pre-throw write never reached the wire and the overlay was restored.
    expect(root.count).toBe(0);
    // Nothing was committed → no yjs update fired (wire-pure rollback).
    expect(shadowUpdates).toBe(0);
    // The value returned to its pre-body state, so the reaction sees no net change.
    expect(notify).not.toHaveBeenCalled();

    dispose();
  });
});
