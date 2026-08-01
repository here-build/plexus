/**
 * T8 / T28 / T30 — domain barrels export disjoint role surfaces.
 * Root re-exports app only; runtime never leaks into app.
 */
import { describe, expect, it } from "vitest";

import * as app from "../app/index.js";
import * as root from "../index.js";
import * as orchestration from "../orchestration/index.js";
import * as runtime from "../runtime/index.js";

const FORBIDDEN_IN_APP = [
  "Orchestrator",
  "activate",
  "reconcile",
  "cancelTree",
  "startResolver",
  "settleSurface",
  "binding",
  "activating",
] as const;

function exportKeys(mod: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(mod).filter((k) => k !== "default" && k !== "__esModule"));
}

describe("PEW domain barrels (T8 T28 T30)", () => {
  it("T30: app / orchestration / runtime export surfaces are pairwise disjoint", () => {
    const a = exportKeys(app as Record<string, unknown>);
    const o = exportKeys(orchestration as Record<string, unknown>);
    const r = exportKeys(runtime as Record<string, unknown>);
    for (const k of a) {
      expect(o.has(k), `app∩orchestration: ${k}`).toBe(false);
      expect(r.has(k), `app∩runtime: ${k}`).toBe(false);
    }
    for (const k of o) {
      expect(r.has(k), `orchestration∩runtime: ${k}`).toBe(false);
    }
  });

  it("T8: app barrel does not export orchestrator / activation surface", () => {
    const a = exportKeys(app as Record<string, unknown>);
    for (const name of FORBIDDEN_IN_APP) {
      expect(a.has(name), `app must not export ${name}`).toBe(false);
    }
  });

  it("T28: root re-exports app only — no runtime symbols on default entry", () => {
    const rootKeys = exportKeys(root as Record<string, unknown>);
    const appKeys = exportKeys(app as Record<string, unknown>);
    for (const name of FORBIDDEN_IN_APP) {
      expect(rootKeys.has(name), `root must not export ${name}`).toBe(false);
    }
    // root keys ⊆ app keys (holds when both empty after scaffold)
    for (const k of rootKeys) {
      expect(appKeys.has(k), `root leaked non-app key: ${k}`).toBe(true);
    }
  });

  it("opacity: app public surface has no domain steer/retry/message-inbox names", () => {
    const a = exportKeys(app as Record<string, unknown>);
    const forbidden = [
      "Message",
      "Inbox",
      "steer",
      "force_steer",
      "stop_retry",
      "retry_now",
      "retry",
    ];
    for (const name of forbidden) {
      expect(a.has(name), `app must not export domain name ${name}`).toBe(false);
    }
    // Control-plane names present
    expect(a.has("ExpectationAdjustment")).toBe(true);
    expect(a.has("ExpectationAdjustmentIntent") || a.has("ADJUSTMENT_TERMINALS")).toBe(true);
  });

  it("runtime exports requestCancellation surface on Orchestrator prototype", () => {
    expect(typeof runtime.Orchestrator.prototype.requestCancellation).toBe("function");
    expect(typeof runtime.Orchestrator.prototype.materializeAdjustment).toBe("function");
  });
});
