/**
 * Runtime: cancelTree abort-first + races (T6, T15, T23, T26).
 *
 * Each host is an Orchestrator subclass — no makeOrch options bag.
 */
import "@here.build/plexus/mobx/register";

import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { Expectation } from "../app/index.js";
import { LaunchDefinition, Orchestration } from "../orchestration/index.js";
import {
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

function launch(): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: "inprocess",
    acceptsMessages: false,
    emitsProgress: false,
    progressMode: "none",
  });
}

/** Default cancel-suite claim-owner host. */
class CancelHost extends Orchestrator {
  readonly starters: Map<string, StartResolverFn>;

  constructor(
    readonly forest: TestForest,
    start: StartResolverFn,
  ) {
    super();
    this.starters = new Map([["inprocess", start]]);
  }

  getOrchestration(): Orchestration {
    return this.forest.orchestration;
  }

  supportsLaunchMode(mode: string): boolean {
    return mode === "inprocess" || mode === "surface";
  }

  resolveModule(kind: string, launchMode: string): StartResolverFn | undefined {
    return this.starters.get(kind) ?? this.starters.get(launchMode);
  }

  registerModule(key: string, start: StartResolverFn): void {
    this.starters.set(key, start);
  }

  isClaimOwner(): boolean {
    return true;
  }

  getOpenWorkRoots(): readonly Expectation[] {
    return this.forest.openWork;
  }

  walkCandidates(): Iterable<Expectation> {
    return [];
  }

  hasLiveClaimPeerBind(_E: Expectation): boolean {
    return false;
  }

  snapshotProductFields(_E: Expectation): unknown {
    return {};
  }

  applyProgress(_E: Expectation, _patch: unknown): void {}

  publishAwarenessBinds(): void {}
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
        actors: new Map([["test.tool", launch()]]),
      }),
      openWork: [E],
    });
    const host = new CancelHost(forest, (input) => {
      signal = input.signal;
      signal.addEventListener("abort", () => {
        stateWhenAborted = E.state;
        abortBeforeCancelled = E.state === "running";
      });
    });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    host.cancelTree(E, "user_cancel");

    expect(abortBeforeCancelled).toBe(true);
    expect(stateWhenAborted).toBe("running");
    expect(signal!.aborted).toBe(true);
    expect(E.state).toBe("cancelled");
    expect(host.binding.has(E)).toBe(false);
    expect(host.activating.has(E)).toBe(false);
  });

  it("T6: cancelTree on parent cancels children (abort + durable)", () => {
    const child = new TestExpectation();
    const parent = new TestExpectation({ children: [child] });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch()]]),
      }),
      openWork: [parent],
    });
    const signals: AbortSignal[] = [];
    const host = new CancelHost(forest, (input) => {
      signals.push(input.signal);
    });

    host.activate(parent);
    host.activate(child);
    expect(parent.state).toBe("running");
    expect(child.state).toBe("running");
    expect(signals).toHaveLength(2);

    host.cancelTree(parent, "user_cancel");

    expect(parent.state).toBe("cancelled");
    expect(child.state).toBe("cancelled");
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(host.binding.has(parent)).toBe(false);
    expect(host.binding.has(child)).toBe(false);
  });

  it("T6: parent complete (terminal) cascades cancelTree on open children", () => {
    const child = new TestExpectation();
    const parent = new TestExpectation({ children: [child] });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch()]]),
      }),
      openWork: [parent],
    });
    let childAborted = false;
    let mode: "child" | "parent" = "child";
    const host = new CancelHost(forest, (input, emit) => {
      input.signal.addEventListener("abort", () => {
        childAborted = true;
      });
      if (mode === "parent") {
        emit({ type: "complete", epoch: input.epoch });
      }
    });

    mode = "child";
    host.activate(child);
    expect(child.state).toBe("running");

    mode = "parent";
    host.activate(parent);
    expect(parent.state).toBe("sealed");
    expect(child.state).toBe("cancelled");
    expect(childAborted).toBe(true);
  });

  it("T23: cancel during activating", () => {
    let cancelDuringStart = false;
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch()]]),
      }),
      openWork: [E],
    });
    const host = new CancelHost(forest, (input, emit) => {
      expect(host.activating.has(E)).toBe(true);
      expect(E.state).toBe("running");
      host.cancelTree(E, "interrupt");
      cancelDuringStart = true;
      emit({ type: "complete", epoch: input.epoch });
    });

    host.activate(E);
    expect(cancelDuringStart).toBe(true);
    expect(E.state).toBe("cancelled");
    expect(host.binding.has(E)).toBe(false);
    expect(host.activating.has(E)).toBe(false);
  });

  it("T26: complete after cancel dropped + AbortSignal fired", () => {
    let emit: EmitFn | undefined;
    let signal: AbortSignal | undefined;
    let abortFired = false;

    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch()]]),
      }),
      openWork: [E],
    });
    const host = new CancelHost(forest, (input, e) => {
      emit = e;
      signal = input.signal;
      signal.addEventListener("abort", () => {
        abortFired = true;
      });
    });

    host.activate(E);
    expect(E.state).toBe("running");

    host.cancelTree(E, "user_cancel");
    expect(abortFired).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(E.state).toBe("cancelled");

    emit!({ type: "complete", epoch: 1 });
    expect(E.state).toBe("cancelled");
  });

  it("cancel of declared (never activated) → cancelled", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch()]]),
      }),
      openWork: [E],
    });
    const host = new CancelHost(forest, () => {
      throw new Error("should not start");
    });

    expect(E.state).toBe("declared");
    host.cancelTree(E, "user_cancel");
    expect(E.state).toBe("cancelled");
  });
});
