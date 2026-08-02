import { describe, expect, it } from "vitest";

import * as executor from "../executor/index.js";
import * as shared from "../index.js";

describe("barrels", () => {
  it("shared barrel: durable model + lifecycle law + control types, no kernel", () => {
    expect(shared.Expectation).toBeDefined();
    expect(shared.LaunchDefinition).toBeDefined();
    expect(shared.Orchestration).toBeDefined();
    expect(shared.isTerminal).toBeDefined();
    expect(shared.isActivatable).toBeDefined();
    expect(shared.PewTerminalWriteError).toBeDefined();
    expect((shared as Record<string, unknown>).Orchestrator).toBeUndefined();
    expect((shared as Record<string, unknown>).ExpectationActor).toBeUndefined();
  });

  it("executor barrel: kernel, loader, actor base", () => {
    expect(executor.Orchestrator).toBeDefined();
    expect(executor.ExpectationLoader).toBeDefined();
    expect(executor.ExpectationActor).toBeDefined();
    expect(executor.walkExpectationForest).toBeDefined();
  });
});
