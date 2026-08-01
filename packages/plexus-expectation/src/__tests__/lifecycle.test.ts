import { describe, expect, it } from "vitest";

import {
  isOpen,
  isTerminal,
  lifecycleCan,
  TERMINAL_LIFECYCLES,
  type Lifecycle,
} from "../app/lifecycle.js";

const ALL: readonly Lifecycle[] = [
  "declared",
  "missing",
  "refused",
  "running",
  "awaiting_rebind",
  "sealed",
  "failed",
  "cancelled",
];

describe("lifecycle helpers", () => {
  it("isTerminal covers sealed | failed | cancelled only", () => {
    expect([...TERMINAL_LIFECYCLES].toSorted()).toEqual(["cancelled", "failed", "sealed"]);
    for (const state of ALL) {
      const terminal = state === "sealed" || state === "failed" || state === "cancelled";
      expect(isTerminal(state)).toBe(terminal);
      expect(isOpen(state)).toBe(!terminal);
    }
  });

  it("isOpen is the complement of isTerminal", () => {
    for (const state of ALL) {
      expect(isOpen(state)).toBe(!isTerminal(state));
    }
  });
});

describe("lifecycle XState graph", () => {
  it("allows the honest orchestrator paths", () => {
    expect(lifecycleCan("declared", "running")).toBe(true);
    expect(lifecycleCan("declared", "missing")).toBe(true);
    expect(lifecycleCan("declared", "refused")).toBe(true);
    expect(lifecycleCan("running", "awaiting_rebind")).toBe(true);
    expect(lifecycleCan("running", "sealed")).toBe(true);
    expect(lifecycleCan("awaiting_rebind", "running")).toBe(true);
    expect(lifecycleCan("awaiting_rebind", "failed")).toBe(true);
  });

  it("refuses short-circuit declare→sealed and all exits from terminals", () => {
    expect(lifecycleCan("declared", "sealed")).toBe(false);
    expect(lifecycleCan("declared", "awaiting_rebind")).toBe(false);
    expect(lifecycleCan("sealed", "running")).toBe(false);
    expect(lifecycleCan("failed", "cancelled")).toBe(false);
    expect(lifecycleCan("cancelled", "declared")).toBe(false);
  });

  it("same-state is always legal (idempotent dual-write)", () => {
    for (const state of ALL) {
      expect(lifecycleCan(state, state)).toBe(true);
    }
  });
});
