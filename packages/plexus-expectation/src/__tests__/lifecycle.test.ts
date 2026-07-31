import { describe, expect, it } from "vitest";

import {
  isOpen,
  isTerminal,
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
    expect([...TERMINAL_LIFECYCLES].sort()).toEqual(["cancelled", "failed", "sealed"]);
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
