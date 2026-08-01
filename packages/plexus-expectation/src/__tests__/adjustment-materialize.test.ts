/**
 * Durable Adjustment materialize + intentId correlation (P3 / C3).
 */
import "@here.build/plexus/mobx/register";
import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Expectation,
  ExpectationAdjustment,
  PROGRESS_FIELD,
  type AdjustmentBag,
  type ExpectationAdjustmentIntent,
} from "../app/index.js";
import { InProcessLaunchDefinition, SurfaceLaunchDefinition, Orchestration } from "../orchestration/index.js";
import { PewTestHost } from "./_helpers/test-host.js";

@syncing("@here.build/plexus-expectation:test.AdjExpectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";
}

@syncing("@here.build/plexus-expectation:test.AdjBag")
class TestAdjBag extends PlexusModel implements AdjustmentBag {
  @syncing.child.list accessor adjustments: ExpectationAdjustment[] = [];

  addAdjustment(adj: ExpectationAdjustment): void {
    this.adjustments.push(adj);
  }
}

@syncing("@here.build/plexus-expectation:test.AdjForest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
  @syncing.child accessor adjBag: TestAdjBag = new TestAdjBag();
}

function launch(): InProcessLaunchDefinition {
  return new InProcessLaunchDefinition();
}

describe("adjustment materialize", () => {
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

  it("materialize copies intentId; uuid is distinct (C3)", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(forest, {}, { adjustmentBag: forest.adjBag });

    const intent: ExpectationAdjustmentIntent = {
      type: "expectationAdjustment",
      intentId: "intent-ephemeral-1",
      targetUuid: E.uuid,
      reshapeEpoch: 0,
      body: { hint: "opaque" },
    };

    const r = host.materializeAdjustment(intent, forest.adjBag);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adjustment.intentId).toBe("intent-ephemeral-1");
    expect(r.adjustment.uuid).not.toBe("intent-ephemeral-1");
    expect(r.adjustment.targetUuid).toBe(E.uuid);
    expect(r.adjustment.consumption).toBe("queued");
    expect(r.adjustment.body).toEqual({ hint: "opaque" });
    expect(r.adjustment instanceof Expectation).toBe(false);
    expect(E.children).toHaveLength(0);
    expect(forest.adjBag.adjustments).toHaveLength(1);
  });

  it("refuses materialize when target terminal", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(forest, {}, { adjustmentBag: forest.adjBag });
    host.activate(E);
    host.cancelTree(E);

    const r = host.materializeAdjustment(
      {
        type: "expectationAdjustment",
        intentId: "i2",
        targetUuid: E.uuid,
        reshapeEpoch: 0,
        body: null,
      },
      forest.adjBag,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("target_terminal");
  });

  it("does not write progress field on materialize", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map([["test.tool", launch()]]) }),
      openWork: [E],
      adjBag: new TestAdjBag(),
    });
    host = new PewTestHost(forest, {}, { adjustmentBag: forest.adjBag });
    host.activate(E);
    host.materializeAdjustment(
      {
        type: "expectationAdjustment",
        intentId: "i3",
        targetUuid: E.uuid,
        reshapeEpoch: 0,
        body: { x: 1 },
      },
      forest.adjBag,
    );
    expect(E.progress).toBeUndefined();
    expect(PROGRESS_FIELD).toBe("progress");
  });
});
