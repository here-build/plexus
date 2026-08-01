/**
 * Pure ExpectationAdjustment consumption machine (P2).
 */
import { describe, expect, it } from "vitest";

import {
  adjustmentAfter,
  adjustmentCan,
  canReshapeAdjustment,
  isAdjustmentOpen,
  isAdjustmentTerminal,
  shouldRedeliverAdjustment,
  shouldRetractOnRebind,
  type AdjustmentConsumptionState,
} from "../app/index.js";

const OPENS: AdjustmentConsumptionState[] = [
  "announced",
  "queued",
  "delivered",
  "accepted",
  "withdrawing",
];
const TERMINALS: AdjustmentConsumptionState[] = ["considered", "withdrawn", "refused"];

describe("adjustment lifecycle machine", () => {
  it("apply ladder is legal", () => {
    expect(adjustmentCan("announced", "queued")).toBe(true);
    expect(adjustmentCan("queued", "delivered")).toBe(true);
    expect(adjustmentCan("delivered", "accepted")).toBe(true);
    expect(adjustmentCan("accepted", "considered")).toBe(true);
  });

  it("rejects skipping to considered from queued", () => {
    expect(adjustmentCan("queued", "considered")).toBe(false);
    expect(adjustmentAfter("queued", "considered")).toBeNull();
  });

  it("terminals are final", () => {
    for (const t of TERMINALS) {
      expect(isAdjustmentTerminal(t)).toBe(true);
      expect(isAdjustmentOpen(t)).toBe(false);
      expect(adjustmentCan(t, "queued")).toBe(false);
    }
  });

  it("withdraw paths", () => {
    expect(adjustmentCan("announced", "withdrawn")).toBe(true);
    expect(adjustmentCan("queued", "withdrawn")).toBe(true);
    expect(adjustmentCan("delivered", "withdrawing")).toBe(true);
    expect(adjustmentCan("accepted", "withdrawing")).toBe(true);
    expect(adjustmentCan("withdrawing", "withdrawn")).toBe(true);
  });

  it("same-state is allowed (idempotent)", () => {
    for (const s of [...OPENS, ...TERMINALS]) {
      expect(adjustmentCan(s, s)).toBe(true);
    }
  });

  it("reshape only while open and epoch increases", () => {
    expect(canReshapeAdjustment("accepted", 0, 1)).toBe(true);
    expect(canReshapeAdjustment("accepted", 1, 1)).toBe(false);
    expect(canReshapeAdjustment("considered", 0, 1)).toBe(false);
    expect(canReshapeAdjustment("withdrawing", 0, 1)).toBe(false);
  });

  it("rebind drain helpers", () => {
    expect(shouldRedeliverAdjustment("queued")).toBe(true);
    expect(shouldRedeliverAdjustment("accepted")).toBe(true);
    expect(shouldRedeliverAdjustment("considered")).toBe(false);
    expect(shouldRetractOnRebind("withdrawing")).toBe(true);
    expect(shouldRetractOnRebind("accepted")).toBe(false);
  });
});
