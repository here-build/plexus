import { describe, expect, it } from "vitest";

import { PewTestHost, TestExpectation } from "./_helpers/test-host.js";
import {
  expectationLifecycleMachine,
  isActivatable,
  isTerminal,
  lifecycleCan,
  lifecycleEventAfter,
  PewTerminalWriteError,
  TERMINAL_LIFECYCLES,
  type Lifecycle,
} from "../shared/index.js";

describe("lifecycle machine", () => {
  it("derives terminals from the machine's final states", () => {
    expect(new Set(TERMINAL_LIFECYCLES)).toEqual(new Set(["sealed", "failed", "cancelled"]));
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("sealed")).toBe(true);
  });

  it("activatable = open and not running, derived — not an event fired into the machine", () => {
    const states = Object.keys(expectationLifecycleMachine.states) as Lifecycle[];
    const activatable = states.filter((s) => isActivatable(s));
    expect(new Set(activatable)).toEqual(new Set(["declared", "missing", "refused"]));
    for (const state of states) {
      expect(
        expectationLifecycleMachine.resolveState({ value: state, context: {} }).can({ type: "ACTIVATE" as never }),
      ).toBe(false);
    }
  });

  it("permits the documented edges and only those", () => {
    expect(lifecycleEventAfter("declared", "BEGIN_RUNNING")).toBe("running");
    expect(lifecycleEventAfter("declared", "PLAN_MISSING")).toBe("missing");
    expect(lifecycleEventAfter("missing", "BEGIN_RUNNING")).toBe("running");
    expect(lifecycleEventAfter("refused", "BEGIN_RUNNING")).toBe("running");
    expect(lifecycleEventAfter("running", "SEAL")).toBe("sealed");
    expect(lifecycleEventAfter("declared", "SEAL")).toBeNull();
    expect(lifecycleEventAfter("sealed", "CANCEL")).toBeNull();
    expect(lifecycleCan("running", "cancelled")).toBe(true);
    expect(lifecycleCan("missing", "sealed")).toBe(false);
  });
});

describe("entity lifecycle writes", () => {
  it("throws PewTerminalWriteError on illegal transitions, no-ops on same state", () => {
    const host = new PewTestHost();
    const E = host.mint(new TestExpectation());
    E.transitionState("declared");
    expect(E.state).toBe("declared");
    expect(() => E.transitionState("sealed")).toThrow(PewTerminalWriteError);
    host.dispose();
  });

  it("applyTerminal is first-writer-wins: a second terminal is a no-op, never a throw", () => {
    const host = new PewTestHost();
    const E = host.mint(new TestExpectation());
    E.transitionState("running");
    expect(E.applyTerminal("sealed", "settled", "", "null", { value: "a" })).toBe(true);
    expect(E.applyTerminal("cancelled", "cancel", "late", "null")).toBe(false);
    expect(E.state).toBe("sealed");
    expect(E.endCause).toBe("settled");
    expect(E.resultValue).toBe("a");
    host.dispose();
  });

  it("author cancel works only during the authorship phase", () => {
    const host = new PewTestHost();
    const E = host.mint(new TestExpectation());
    const child = new TestExpectation();
    E.children.push(child);
    expect(E.authorCancel("changed my mind")).toBe(true);
    expect(E.state).toBe("cancelled");
    expect(E.endCause).toBe("cancel");
    expect(E.endDetail).toBe("changed my mind");
    expect(child.state).toBe("cancelled");

    const F = host.mint(new TestExpectation());
    F.transitionState("running");
    expect(F.authorCancel()).toBe(false);
    expect(F.state).toBe("running");
    host.dispose();
  });

  it("clone copies the declaration and resets execution-derived fields", () => {
    const host = new PewTestHost();
    const E = host.mint(new TestExpectation());
    E.payload = "declared-data";
    E.transitionState("running");
    E.applyTerminal("failed", "crash", "boom", '{"note":"last"}');
    const retry = E.clone();
    expect(retry.payload).toBe("declared-data");
    expect(retry.state).toBe("declared");
    expect(retry.endCause).toBe("");
    expect(retry.endDetail).toBe("");
    expect(retry.lastReportJson).toBe("null");
    expect(retry.processorClientId).toBe(0);
    host.dispose();
  });
});
