/**
 * PR-3 runtime: cancelTree abort-first + races (T6, T15, T23, T26).
 */
import "@here.build/plexus/mobx/register";

import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { Expectation } from "../app/index.js";
import { LaunchDefinition, Orchestration } from "../orchestration/index.js";
import {
  modulesFromRecord,
  Orchestrator,
  type EmitFn,
  type StartResolverFn,
} from "../runtime/index.js";

@syncing("@here.build/plexus-expectation:test.CancelExpectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";
}

@syncing("@here.build/plexus-expectation:test.CancelForest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
}

function def(): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: "inprocess",
    acceptsMessages: false,
    emitsProgress: false,
    progressMode: "none",
  });
}

function makeOrchestrator(forest: TestForest, start: StartResolverFn): Orchestrator {
  return new Orchestrator({
    getOrchestration: () => forest.orchestration,
    loadedModules: new Set(["inprocess", "surface"]),
    modules: modulesFromRecord({ inprocess: start }),
  });
}

describe("runtime cancelTree", () => {
  beforeEach(() => resetLocalIDs());

  it("T15: cancel running — AbortSignal fires before state becomes cancelled", () => {
    let signal: AbortSignal | undefined;
    let abortBeforeCancelled = false;
    let stateWhenAborted: string | undefined;

    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def()]]),
      }),
      openWork: [E],
    });

    const orchestrator = makeOrchestrator(forest, (input) => {
      signal = input.signal;
      signal.addEventListener("abort", () => {
        stateWhenAborted = E.state;
        abortBeforeCancelled = E.state === "running";
      });
    });

    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    orchestrator.cancelTree(E, "user_cancel");

    expect(abortBeforeCancelled).toBe(true);
    expect(stateWhenAborted).toBe("running");
    expect(signal!.aborted).toBe(true);
    expect(E.state).toBe("cancelled");
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(orchestrator.activating.has(E)).toBe(false);
  });

  it("T6: cancelTree on parent cancels children (abort + durable)", () => {
    const child = new TestExpectation();
    const parent = new TestExpectation({ children: [child] });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def()]]),
      }),
      openWork: [parent],
    });

    const signals: AbortSignal[] = [];
    const orchestrator = makeOrchestrator(forest, (input) => {
      signals.push(input.signal);
    });

    orchestrator.activate(parent);
    orchestrator.activate(child);
    expect(parent.state).toBe("running");
    expect(child.state).toBe("running");
    expect(signals).toHaveLength(2);

    orchestrator.cancelTree(parent, "user_cancel");

    expect(parent.state).toBe("cancelled");
    expect(child.state).toBe("cancelled");
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(orchestrator.binding.has(parent)).toBe(false);
    expect(orchestrator.binding.has(child)).toBe(false);
  });

  it("T6: parent complete (terminal) cascades cancelTree on open children", () => {
    const child = new TestExpectation();
    const parent = new TestExpectation({ children: [child] });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def()]]),
      }),
      openWork: [parent],
    });

    let childAborted = false;
    let mode: "child" | "parent" = "child";

    const orchestrator = makeOrchestrator(forest, (input, emit) => {
      input.signal.addEventListener("abort", () => {
        childAborted = true;
      });
      if (mode === "parent") {
        emit({ type: "complete", epoch: input.epoch });
      }
      // child mode: leave running
    });

    mode = "child";
    orchestrator.activate(child);
    expect(child.state).toBe("running");

    mode = "parent";
    orchestrator.activate(parent);
    expect(parent.state).toBe("sealed");
    expect(child.state).toBe("cancelled");
    expect(childAborted).toBe(true);
  });

  it("T23: cancel during activating", () => {
    let cancelDuringStart = false;
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def()]]),
      }),
      openWork: [E],
    });

    const orchestrator = makeOrchestrator(forest, (input, emit) => {
      expect(orchestrator.activating.has(E)).toBe(true);
      expect(E.state).toBe("running");
      orchestrator.cancelTree(E, "interrupt");
      cancelDuringStart = true;
      // Further emit must be dropped
      emit({ type: "complete", epoch: input.epoch });
    });

    orchestrator.activate(E);
    expect(cancelDuringStart).toBe(true);
    expect(E.state).toBe("cancelled");
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(orchestrator.activating.has(E)).toBe(false);
  });

  it("T26: complete after cancel dropped + AbortSignal fired", () => {
    let emit: EmitFn | undefined;
    let signal: AbortSignal | undefined;
    let abortFired = false;

    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def()]]),
      }),
      openWork: [E],
    });

    const orchestrator = makeOrchestrator(forest, (input, e) => {
      emit = e;
      signal = input.signal;
      signal.addEventListener("abort", () => {
        abortFired = true;
      });
    });

    orchestrator.activate(E);
    expect(E.state).toBe("running");

    orchestrator.cancelTree(E, "user_cancel");
    expect(abortFired).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(E.state).toBe("cancelled");

    emit!({ type: "complete", epoch: 1 });
    expect(E.state).toBe("cancelled"); // not sealed
  });

  it("cancel of declared (never activated) → cancelled", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def()]]),
      }),
      openWork: [E],
    });
    const orchestrator = makeOrchestrator(forest, () => {
      throw new Error("should not start");
    });
    expect(E.state).toBe("declared");
    orchestrator.cancelTree(E, "user_cancel");
    expect(E.state).toBe("cancelled");
  });
});
