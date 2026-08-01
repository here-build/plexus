/**
 * Runtime: cancelTree abort-first + races (T6, T15, T23, T26).
 * Host = doc-backed PewTestHost.
 */
import "@here.build/plexus/mobx/register";
import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Expectation } from "../app/index.js";
import { InProcessLaunchDefinition, SurfaceLaunchDefinition, Orchestration } from "../orchestration/index.js";
import type { EmitFn } from "../runtime/index.js";
import { PewTestHost } from "./_helpers/test-host.js";

@syncing("@here.build/plexus-expectation:test.CancelExpectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";
}

@syncing("@here.build/plexus-expectation:test.CancelForest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
}

function launch(): InProcessLaunchDefinition {
  return new InProcessLaunchDefinition();
}

function forestWith(...units: TestExpectation[]): TestForest {
  return new TestForest({
    orchestration: new Orchestration({
      actors: new Map([["test.tool", launch()]]),
    }),
    openWork: units,
  });
}

describe("runtime cancelTree", () => {
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

  it("T15: cancel running — AbortSignal fires before state becomes cancelled", () => {
    let signal: AbortSignal | undefined;
    let abortBeforeCancelled = false;
    let stateWhenAborted: string | undefined;

    const E = new TestExpectation();
    host = new PewTestHost(forestWith(E), {
      inprocess: (input) => {
        signal = input.signal;
        signal.addEventListener("abort", () => {
          stateWhenAborted = E.state;
          abortBeforeCancelled = E.state === "running";
        });
      },
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
    const signals: AbortSignal[] = [];
    host = new PewTestHost(forestWith(parent), {
      inprocess: (input) => {
        signals.push(input.signal);
      },
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
    let childAborted = false;
    let mode: "child" | "parent" = "child";
    host = new PewTestHost(forestWith(parent), {
      inprocess: (input, emit) => {
        input.signal.addEventListener("abort", () => {
          childAborted = true;
        });
        if (mode === "parent") {
          emit({ type: "complete", epoch: input.epoch });
        }
      },
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
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, emit) => {
        expect(host!.activating.has(E)).toBe(true);
        expect(E.state).toBe("running");
        host!.cancelTree(E, "interrupt");
        cancelDuringStart = true;
        emit({ type: "complete", epoch: input.epoch });
      },
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
    host = new PewTestHost(forestWith(E), {
      inprocess: (input, e) => {
        emit = e;
        signal = input.signal;
        signal.addEventListener("abort", () => {
          abortFired = true;
        });
      },
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
    host = new PewTestHost(forestWith(E), {
      inprocess: () => {
        throw new Error("should not start");
      },
    });

    expect(E.state).toBe("declared");
    host.cancelTree(E, "user_cancel");
    expect(E.state).toBe("cancelled");
  });
});
