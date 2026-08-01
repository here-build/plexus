/**
 * Simplex adjustment channel + requestCancellation (P1/P4 / C1 / C2).
 */
import "@here.build/plexus/mobx/register";
import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Expectation,
  ExpectationAdjustment,
  type AdjustmentBag,
  type ExpectationAdjustmentIntent,
} from "../app/index.js";
import { InProcessLaunchDefinition, SurfaceLaunchDefinition, Orchestration } from "../orchestration/index.js";
import type { AdjustmentSnapshot, ControlAckFn, EmitFn } from "../runtime/index.js";
import { PewTestHost } from "./_helpers/test-host.js";

@syncing("@here.build/plexus-expectation:test.ChExpectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";
}

@syncing("@here.build/plexus-expectation:test.ChBag")
class TestAdjBag extends PlexusModel implements AdjustmentBag {
  @syncing.child.list accessor adjustments: ExpectationAdjustment[] = [];
  addAdjustment(adj: ExpectationAdjustment): void {
    this.adjustments.push(adj);
  }
}

@syncing("@here.build/plexus-expectation:test.ChForest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
  @syncing.child accessor adjBag: TestAdjBag = new TestAdjBag();
}

function launch(): InProcessLaunchDefinition {
  return new InProcessLaunchDefinition();
}

function intentFor(E: Expectation, intentId: string): ExpectationAdjustmentIntent {
  return {
    type: "expectationAdjustment",
    intentId,
    targetUuid: E.uuid,
    reshapeEpoch: 0,
    body: { note: "opaque" },
  };
}

describe("requestCancellation (C1)", () => {
  let host: PewTestHost | undefined;

  beforeEach(() => {
    resetLocalIDs();
    Expectation.bindProgressHub(null);
    host = undefined;
  });
  afterEach(() => {
    host?.dispose();
    Expectation.bindProgressHub(null);
  });

  it("immediate invokes cancelTree physics", () => {
    let aborted = false;
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
    });
    host = new PewTestHost(forest, {
      inprocess: (input) => {
        input.signal.addEventListener("abort", () => {
          aborted = true;
        });
      },
    });
    host.activate(E);
    const r = host.requestCancellation(E, { strength: "immediate", reason: "user" });
    expect(r.ok).toBe(true);
    expect(aborted).toBe(true);
    expect(E.state).toBe("cancelled");
  });

  it("raw cancelTree still works alongside API (C1 multi-writer)", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
    });
    host = new PewTestHost(forest, { inprocess: () => {} });
    host.activate(E);
    host.cancelTree(E, "direct");
    expect(E.state).toBe("cancelled");
  });

  it("cooperative is stub-refused", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
    });
    host = new PewTestHost(forest, { inprocess: () => {} });
    host.activate(E);
    const r = host.requestCancellation(E, { strength: "cooperative" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("cooperative_not_implemented");
    expect(E.state).toBe("running");
  });
});

describe("adjustment channel simplex", () => {
  let host: PewTestHost | undefined;

  beforeEach(() => {
    resetLocalIDs();
    Expectation.bindProgressHub(null);
    host = undefined;
  });
  afterEach(() => {
    host?.dispose();
    Expectation.bindProgressHub(null);
  });

  it("deliver → ackWillConsider → markConsidered does not mutate E (C2)", () => {
    const delivered: AdjustmentSnapshot[] = [];
    let control: ControlAckFn | undefined;

    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(
      forest,
      {
        inprocess: (input, _emit: EmitFn, ctl) => {
          control = ctl;
          return {
            get aborted() {
              return input.signal.aborted;
            },
            abort() {
              /* host AbortController owns signal */
            },
            deliverAdjustment(s) {
              delivered.push(s);
            },
          };
        },
      },
      { adjustmentBag: forest.adjBag },
    );

    host.activate(E);
    expect(E.state).toBe("running");
    const epochBefore = E.bindEpoch;

    const mat = host.materializeAdjustment(intentFor(E, "ch-1"), forest.adjBag);
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;
    const adj = mat.adjustment;

    const d = host.deliverAdjustment(E, adj);
    expect(d.ok).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.intentId).toBe("ch-1");
    expect(delivered[0]!.adjustmentUuid).toBe(adj.uuid);
    expect(adj.consumption).toBe("delivered");

    expect(control).toBeDefined();
    control!({ type: "ackWillConsider", intentId: "ch-1", reshapeEpoch: 0 });
    expect(adj.consumption).toBe("accepted");

    control!({ type: "markConsidered", intentId: "ch-1", reshapeEpoch: 0 });
    expect(adj.consumption).toBe("considered");

    // C2: Expectation still running; epoch unchanged
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(epochBefore);
  });

  it("cancelTree refuses open adjustments targeting E", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(forest, { inprocess: () => {} }, { adjustmentBag: forest.adjBag });
    host.activate(E);
    const mat = host.materializeAdjustment(intentFor(E, "ch-2"), forest.adjBag);
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;
    host.cancelTree(E);
    expect(mat.adjustment.consumption).toBe("refused");
  });

  it("rebind drain re-delivers queued adjustments", () => {
    const delivered: string[] = [];
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(
      forest,
      {
        inprocess: (input) => ({
          get aborted() {
            return input.signal.aborted;
          },
          abort() {},
          deliverAdjustment(s) {
            delivered.push(s.intentId);
          },
        }),
      },
      { adjustmentBag: forest.adjBag },
    );

    host.activate(E);
    host.materializeAdjustment(intentFor(E, "ch-3"), forest.adjBag);
    // First activate drains after bind — materialize after first activate needs explicit deliver or re-activate
    host.markAwaitingRebind(E, { incrementRebind: false, reason: "test" });
    delivered.length = 0;
    host.activate(E);
    expect(delivered).toContain("ch-3");
  });

  it("seal path: materialize then complete refuses adj", () => {
    let emitFn: EmitFn | undefined;
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(
      forest,
      {
        inprocess: (input, emit) => {
          emitFn = emit;
          return {
            get aborted() {
              return input.signal.aborted;
            },
            abort() {},
          };
        },
      },
      { adjustmentBag: forest.adjBag },
    );
    host.activate(E);
    const mat = host.materializeAdjustment(intentFor(E, "ch-seal"), forest.adjBag);
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;
    emitFn!({ type: "complete", epoch: E.bindEpoch });
    expect(E.state).toBe("sealed");
    expect(mat.adjustment.consumption).toBe("refused");
  });

  it("intentId open-first: recycled id after terminal hits live row", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(forest, { inprocess: () => {} }, { adjustmentBag: forest.adjBag });
    host.activate(E);
    const first = host.materializeAdjustment(intentFor(E, "recycle"), forest.adjBag);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.adjustment.markRefused();
    expect(first.adjustment.consumption).toBe("refused");

    const second = host.materializeAdjustment(intentFor(E, "recycle"), forest.adjBag);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.adjustment.uuid).not.toBe(first.adjustment.uuid);

    host.deliverAdjustment(E, second.adjustment);
    const ack = host.applyControlAck({
      type: "ackWillConsider",
      intentId: "recycle",
      reshapeEpoch: 0,
    });
    expect(ack.ok).toBe(true);
    expect(second.adjustment.consumption).toBe("accepted");
    expect(first.adjustment.consumption).toBe("refused");
  });

  it("retract → withdrawing → ackDropped → withdrawn", () => {
    const retracted: string[] = [];
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(
      forest,
      {
        inprocess: (input) => ({
          get aborted() {
            return input.signal.aborted;
          },
          abort() {},
          deliverAdjustment() {},
          retractAdjustment(key) {
            if ("intentId" in key) retracted.push(key.intentId);
          },
        }),
      },
      { adjustmentBag: forest.adjBag },
    );
    host.activate(E);
    const mat = host.materializeAdjustment(intentFor(E, "ch-ret"), forest.adjBag);
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;
    host.deliverAdjustment(E, mat.adjustment);
    expect(mat.adjustment.consumption).toBe("delivered");

    const r = host.retractAdjustment({ intentId: "ch-ret" }, 0);
    expect(r.ok).toBe(true);
    expect(mat.adjustment.consumption).toBe("withdrawing");
    expect(retracted).toContain("ch-ret");

    const drop = host.applyControlAck({
      type: "ackDropped",
      intentId: "ch-ret",
      reshapeEpoch: 0,
    });
    expect(drop.ok).toBe(true);
    expect(mat.adjustment.consumption).toBe("withdrawn");
  });

  it("reshape bumps epoch and notifies handle", () => {
    const reshaped: number[] = [];
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(
      forest,
      {
        inprocess: (input) => ({
          get aborted() {
            return input.signal.aborted;
          },
          abort() {},
          deliverAdjustment() {},
          reshapeAdjustment(s) {
            reshaped.push(s.reshapeEpoch);
          },
        }),
      },
      { adjustmentBag: forest.adjBag },
    );
    host.activate(E);
    host.materializeAdjustment(intentFor(E, "ch-rs"), forest.adjBag);
    const r = host.reshapeAdjustment({
      type: "expectationAdjustment",
      intentId: "ch-rs",
      targetUuid: E.uuid,
      reshapeEpoch: 1,
      body: { harder: true },
    });
    expect(r.ok).toBe(true);
    expect(reshaped).toEqual([1]);
  });

  it("requestCancellation not_claim_owner", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
    });
    host = new PewTestHost(forest, { inprocess: () => {} }, { claimOwner: false });
    const r = host.requestCancellation(E, { strength: "immediate" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_claim_owner");
  });
});
