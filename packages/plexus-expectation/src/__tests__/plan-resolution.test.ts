/**
 * Pure plan resolution via Orchestrator.resolvePlan (no activate).
 */
import { describe, expect, it } from "vitest";

import { LaunchDefinition, Orchestration, type LaunchMode, type ProgressMode } from "../orchestration/index.js";
import { Orchestrator } from "../runtime/index.js";

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

function actors(entries: ReadonlyArray<readonly [string, LaunchDefinition]> = []): {
  get(kind: string): LaunchDefinition | undefined;
} {
  return new Map(entries);
}

const only =
  (...modes: string[]) =>
  (mode: string) =>
    modes.includes(mode);

describe("Orchestrator.resolvePlan", () => {
  it("T1: no plan → missing", () => {
    const outcome = Orchestrator.resolvePlan("tool_call", { actors: actors() }, only("inprocess"));
    expect(outcome).toEqual({ status: "missing" });
  });

  it("T2: unsupported mode → refused", () => {
    const launch = def({ launchMode: "inprocess" });
    const outcome = Orchestrator.resolvePlan("tool_call", { actors: actors([["tool_call", launch]]) }, only("surface"));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.def).toBe(launch);
    }
  });

  it("bound when mode supported", () => {
    const launch = def({
      launchMode: "surface",
      acceptsMessages: false,
      emitsProgress: false,
      progressMode: "none",
    });
    const outcome = Orchestrator.resolvePlan(
      "harness.approval",
      { actors: actors([["harness.approval", launch]]) },
      only("inprocess", "surface"),
    );
    expect(outcome).toEqual({ status: "bound", def: launch });
  });

  it("unknown kind is missing even when other kinds are registered", () => {
    expect(
      Orchestrator.resolvePlan(
        "other",
        { actors: actors([["tool_call", def({ launchMode: "inprocess" })]]) },
        only("inprocess"),
      ),
    ).toEqual({ status: "missing" });
  });

  it("accepts real Orchestration", () => {
    const launch = def({
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
