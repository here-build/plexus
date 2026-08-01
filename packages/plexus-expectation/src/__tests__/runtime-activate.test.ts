/**
 * Runtime: activate + emit (T1–T5, T9, T16, T19, T24, T25).
 * Host = doc-backed PewTestHost (real awareness + progress plane).
 */
import "@here.build/plexus/mobx/register";
import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Expectation } from "../app/index.js";
import {
  ProgressiveInProcessLaunchDefinition,
  SurfaceLaunchDefinition,
  Orchestration,
} from "../orchestration/index.js";
import type { ResolverStartInput, StartResolverFn } from "../runtime/index.js";
import { PewTestHost } from "./_helpers/test-host.js";

@syncing("@here.build/plexus-expectation:test.RuntimeExpectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";

  @syncing accessor payload: string = "";
}

@syncing("@here.build/plexus-expectation:test.RuntimeForest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
}

function launch(
  mode: "inprocess" | "surface" = "inprocess",
): ProgressiveInProcessLaunchDefinition | SurfaceLaunchDefinition {
  if (mode === "surface") return new SurfaceLaunchDefinition();
  return new ProgressiveInProcessLaunchDefinition();
}

function forestWith(E: TestExpectation, mode: "inprocess" | "surface" = "inprocess"): TestForest {
  return new TestForest({
    orchestration: new Orchestration({
      actors: new Map([["test.tool", launch(mode)]]),
    }),
    openWork: [E],
  });
}

describe("runtime activate / emit", () => {
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

  it("T1: no plan → missing via activate", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map() }),
      openWork: [E],
    });
    host = new PewTestHost(forest, {
      inprocess: (input, emit) => {
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(E.state).toBe("missing");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T2: plan present, strategy unsupported → refused", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), {
      inprocess: (input, emit) => {
        emit({ type: "complete", epoch: input.epoch });
      },
    }, { modes: new Set(["inprocess"]) });

    host.activate(E);
    expect(E.state).toBe("refused");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T3: inprocess progress + complete (plane SSoT)", () => {
    const E = new TestExpectation({ payload: "in" });
    let mid: unknown;
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { n: 1 } });
        emit({ type: "progress", epoch: input.epoch, patch: { n: 2 } });
        mid = E.progress;
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(mid).toEqual({ n: 2 });
    expect(E.state).toBe("sealed");
    expect(E.progress).toBeUndefined();
    expect(host.binding.has(E)).toBe(false);
    expect(E.bindEpoch).toBe(1);
  });

  it("T4: stale epoch emit dropped", () => {
    const E = new TestExpectation({ payload: "in" });
    let captured: { emit: Parameters<StartResolverFn>[1]; epoch: number } | undefined;
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        captured = { emit, epoch: input.epoch };
      },
    });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(1);

    captured!.emit({ type: "progress", epoch: 0, patch: { stale: true } });
    captured!.emit({ type: "complete", epoch: 0 });
    expect(E.progress).toBeUndefined();
    expect(E.state).toBe("running");

    captured!.emit({ type: "progress", epoch: 1, patch: { ok: true } });
    expect(E.progress).toEqual({ ok: true });
    captured!.emit({ type: "complete", epoch: 1 });
    expect(E.state).toBe("sealed");
    expect(E.progress).toBeUndefined();
  });

  it("T5 / T24: activation single-flight (concurrent activate)", () => {
    const E = new TestExpectation({ payload: "in" });
    let entries = 0;
    let reentrantActivate = 0;
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        entries += 1;
        host!.activate(E);
        if (host!.activating.has(E)) reentrantActivate += 1;
        host!.activate(E);
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(entries).toBe(1);
    expect(reentrantActivate).toBe(1);
    expect(E.state).toBe("sealed");
    host.activate(E);
    expect(entries).toBe(1);
  });

  it("T9: resolver gets snapshot only — no Expectation entity / doc", () => {
    const E = new TestExpectation({ payload: "in" });
    let seen: ResolverStartInput | undefined;
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        seen = input;
        const json = JSON.parse(JSON.stringify(input)) as ResolverStartInput;
        expect(json.kind).toBe("test.tool");
        expect(json.epoch).toBe(1);
        expect(json.definition.strategy).toBe("inprocess");
        expect(json.input).toEqual({ payload: "in" });
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("doc");
    expect(seen).not.toHaveProperty("E");
    expect(seen!.input).toEqual({ payload: "in" });
    expect(seen!.input).not.toBe(E);
  });

  it("T16: startResolver throw → failed, epoch burned", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), {
      inprocess: () => {
        throw new Error("boom");
      },
    });

    host.activate(E);
    expect(E.state).toBe("failed");
    expect(E.bindEpoch).toBe(1);
    expect(host.binding.has(E)).toBe(false);
  });

  it("T19: sync complete before startResolver returns is applied", () => {
    const E = new TestExpectation({ payload: "in" });
    let stateAtReturn: string | undefined;
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        emit({ type: "complete", epoch: input.epoch });
        stateAtReturn = E.state;
      },
    });

    host.activate(E);
    expect(stateAtReturn).toBe("sealed");
    expect(E.state).toBe("sealed");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T25: binding/activating use entity keys (not uuid strings)", () => {
    const E = new TestExpectation({ payload: "in" });
    let midBindKeys: unknown[] = [];
    let midActivatingHasEntity = false;
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        midBindKeys = [...host!.binding.keys()];
        midActivatingHasEntity = host!.activating.has(E);
        expect(host!.binding.has(E)).toBe(true);
        for (const k of midBindKeys) {
          expect(typeof k).not.toBe("string");
          expect(k).toBeInstanceOf(Expectation);
        }
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(midActivatingHasEntity).toBe(true);
    expect(midBindKeys).toHaveLength(1);
    expect(midBindKeys[0]).toBe(E);
  });

  it("surface mode uses mode-level starter (not inprocess)", () => {
    const inprocess = vi.fn();
    const surface = vi.fn(() => {
      /* leave running — human settle */
    });
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), { inprocess, surface });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(inprocess).not.toHaveBeenCalled();
    expect(surface).toHaveBeenCalledOnce();
    expect(host.binding.has(E)).toBe(true);
    expect(host.binding.get(E)!.epoch).toBe(E.bindEpoch);
  });

  it("running + healthy bind is idempotent", () => {
    const E = new TestExpectation({ payload: "in" });
    let starts = 0;
    host = new PewTestHost(forestWith(E), {
      inprocess: () => {
        starts += 1;
      },
    });

    host.activate(E);
    host.activate(E);
    expect(starts).toBe(1);
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(1);
  });

  it("fail emit → failed", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        emit({ type: "fail", epoch: input.epoch, reason: "x" });
      },
    });

    host.activate(E);
    expect(E.state).toBe("failed");
  });

  it("missing starter waits (no durable run); late register + reconcile activates", () => {
    const E = new TestExpectation({ payload: "late" });
    host = new PewTestHost(forestWith(E), {});

    host.activate(E);
    expect(E.state).toBe("declared");
    expect(host.binding.has(E)).toBe(false);
    expect(E.bindEpoch).toBe(0);

    host.registerModule("inprocess", (input, emit) => {
      emit({ type: "complete", epoch: input.epoch });
    });
    host.reconcile();

    expect(E.state).toBe("sealed");
    expect(E.bindEpoch).toBe(1);
  });
});
