/**
 * Pure plan resolution via Orchestrator.resolvePlan (no activate).
 */
import { describe, expect, it } from "vitest";

import { LaunchDefinition, type LaunchMode, Orchestration } from "../orchestration/index.js";
import { type ProgressMode } from "../app/progress-plane.js";
import { Orchestrator } from "../runtime/index.js";

const only =
  (...modes: string[]) =>
  (mode: string) =>
    modes.includes(mode);

describe("Orchestrator.resolvePlan", () => {
  it("T1: no plan → missing", () => {
    const outcome = Orchestrator.resolvePlan("tool_call", new Orchestration({ actors: new Map() }), only("inprocess"));
    expect(outcome).toEqual({ status: "missing" });
  });

  it("T2: unsupported mode → refused", () => {
    const launch = new LaunchDefinition({ launchMode: "inprocess" });
    const outcome = Orchestrator.resolvePlan(
      "tool_call",
      new Orchestration({ actors: new Map([["tool_call", launch]]) }),
      only("surface"),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.def).toBe(launch);
    }
  });

  it("bound when mode supported", () => {
    const launch = new LaunchDefinition({
      launchMode: "surface",
      acceptsMessages: false,
      emitsProgress: false,
      progressMode: "none",
    });
    const outcome = Orchestrator.resolvePlan(
      "harness.approval",
      new Orchestration({ actors: new Map([["harness.approval", launch]]) }),
      only("inprocess", "surface"),
    );
    expect(outcome).toEqual({ status: "bound", def: launch });
  });

  it("unknown kind is missing even when other kinds are registered", () => {
    expect(
      Orchestrator.resolvePlan(
        "other",
        new Orchestration({ actors: new Map([["tool_call", new LaunchDefinition({ launchMode: "inprocess" })]]) }),
        only("inprocess"),
      ),
    ).toEqual({ status: "missing" });
  });

  it("accepts real Orchestration", () => {
    const launch = new LaunchDefinition({
      launchMode: "inprocess",
      emitsProgress: true,
      progressMode: "lww",
    });
    const orchestration = new Orchestration({
      actors: new Map([["tool_call", launch]]),
    });
    expect(Orchestrator.resolvePlan("tool_call", orchestration, only("inprocess"))).toEqual({
      status: "bound",
      def: launch,
    });
    expect(Orchestrator.resolvePlan("missing_kind", orchestration, only("inprocess"))).toEqual({
      status: "missing",
    });
  });
});
