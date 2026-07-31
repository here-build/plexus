/**
 * T1 / T2 — pure plan resolution (spec §4.3).
 * No runtime, no activate, no Expectation.
 */
import { describe, expect, it } from "vitest";

import {
  LaunchDefinition,
  Orchestration,
  resolvePlan,
  type LaunchMode,
  type PlanActorsSource,
  type ProgressMode,
} from "../orchestration/index.js";

function def(partial: {
  launchMode: LaunchMode;
  acceptsMessages?: boolean;
  emitsProgress?: boolean;
  progressMode?: ProgressMode;
}): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: partial.launchMode,
    acceptsMessages: partial.acceptsMessages ?? false,
    emitsProgress: partial.emitsProgress ?? false,
    progressMode: partial.progressMode ?? "none",
  });
}

function plan(
  entries: ReadonlyArray<readonly [string, LaunchDefinition]> = [],
): PlanActorsSource {
  return { actors: new Map(entries) };
}

describe("resolvePlan (T1 T2)", () => {
  it("T1: no plan → missing", () => {
    const outcome = resolvePlan("tool_call", plan(), new Set(["inprocess"]));
    expect(outcome).toEqual({ status: "missing" });
  });

  it("T2: unloaded mode → refused", () => {
    const launch = def({ launchMode: "inprocess" });
    // surface loaded, but plan wants inprocess
    const outcome = resolvePlan("tool_call", plan([["tool_call", launch]]), new Set(["surface"]));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.def).toBe(launch);
    }
  });

  it("bound when mode loaded", () => {
    const launch = def({
      launchMode: "surface",
      acceptsMessages: false,
      emitsProgress: false,
      progressMode: "none",
    });
    const outcome = resolvePlan(
      "harness.approval",
      plan([["harness.approval", launch]]),
      new Set(["inprocess", "surface"]),
    );
    expect(outcome).toEqual({ status: "bound", def: launch });
  });

  it("unknown kind is missing even when other kinds are registered", () => {
    expect(
      resolvePlan(
        "other",
        plan([["tool_call", def({ launchMode: "inprocess" })]]),
        new Set(["inprocess"]),
      ),
    ).toEqual({ status: "missing" });
  });

  it("accepts real Orchestration as PlanActorsSource", () => {
    const launch = def({ launchMode: "inprocess", emitsProgress: true, progressMode: "lww" });
    const orchestration = new Orchestration({
      actors: new Map([["tool_call", launch]]),
    });
    expect(resolvePlan("tool_call", orchestration, new Set(["inprocess"]))).toEqual({
      status: "bound",
      def: launch,
    });
    expect(resolvePlan("missing_kind", orchestration, new Set(["inprocess"]))).toEqual({
      status: "missing",
    });
  });
});
