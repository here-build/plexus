/**
 * Pure plan resolution via Orchestrator.resolvePlan (no activate).
 */
import { describe, expect, it } from "vitest";

import {
  InProcessLaunchDefinition,
  SurfaceLaunchDefinition,
  Orchestration,
} from "../orchestration/index.js";
import { Orchestrator } from "../runtime/index.js";

describe("Orchestrator.resolvePlan", () => {
  it("T1: no plan → missing", () => {
    const outcome = Orchestrator.resolvePlan("tool_call", new Orchestration({ actors: new Map() }), () => true);
    expect(outcome).toEqual({ status: "missing" });
  });

  it("T2: plan present, host cannot run → refused", () => {
    const launch = new InProcessLaunchDefinition();
    const outcome = Orchestrator.resolvePlan(
      "tool_call",
      new Orchestration({ actors: new Map([["tool_call", launch]]) }),
      () => false,
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.def).toBe(launch);
    }
  });

  it("bound when host can run plan", () => {
    const launch = new SurfaceLaunchDefinition();
    const outcome = Orchestrator.resolvePlan(
      "harness.approval",
      new Orchestration({ actors: new Map([["harness.approval", launch]]) }),
      () => true,
    );
    expect(outcome).toEqual({ status: "bound", def: launch });
  });

  it("unknown kind is missing even when other kinds are registered", () => {
    expect(
      Orchestrator.resolvePlan(
        "other",
        new Orchestration({ actors: new Map([["tool_call", new InProcessLaunchDefinition()]]) }),
        () => true,
      ),
    ).toEqual({ status: "missing" });
  });

  it("accepts real Orchestration", () => {
    const launch = new InProcessLaunchDefinition();
    const orchestration = new Orchestration({
      actors: new Map([["tool_call", launch]]),
    });
    expect(Orchestrator.resolvePlan("tool_call", orchestration, () => true)).toEqual({
      status: "bound",
      def: launch,
    });
    expect(Orchestrator.resolvePlan("missing_kind", orchestration, () => true)).toEqual({
      status: "missing",
    });
  });
});
