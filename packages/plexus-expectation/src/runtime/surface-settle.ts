/**
 * settleSurface — claim-owner API for surface-mode human resolution (§5.4).
 *
 * abandon → cancelled; allow|deny → sealed. Structured errors only (no throw).
 */

import type { Expectation } from "../app/expectation.js";
import type { SettleSurfaceDisposition } from "../app/intents.js";
import { isTerminal } from "../app/lifecycle.js";

import type { Orchestrator } from "./orchestrator.js";

/** Body of a surface settle (from {@link import("../app/intents.js").SettleSurfaceIntent} after E resolve). */
export type SettleSurfaceBody = {
  /** Caller's observed `bindEpoch` — must match durable + local bind. */
  readonly epoch: number;
  readonly disposition: SettleSurfaceDisposition;
};

export type SettleSurfaceErrorCode = "not_claim_owner" | "not_running" | "stale_epoch";

export type SettleSurfaceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SettleSurfaceErrorCode };

/**
 * Settle a surface-mode Expectation (approve / deny / abandon).
 *
 * ```
 * not claim owner → not_claim_owner
 * state ≠ running → not_running
 * bind missing | epoch mismatch → stale_epoch
 * abandon → cancelled; allow|deny → sealed
 * ```
 */
export function settleSurface(
  orch: Orchestrator,
  E: Expectation,
  body: SettleSurfaceBody,
): SettleSurfaceResult {
  if (!orch.isClaimOwner()) {
    return { ok: false, code: "not_claim_owner" };
  }
  if (E.state !== "running") {
    return { ok: false, code: "not_running" };
  }

  const bind = orch.binding.get(E);
  if (!bind || bind.epoch !== E.bindEpoch || body.epoch !== E.bindEpoch) {
    return { ok: false, code: "stale_epoch" };
  }

  const terminal: "sealed" | "cancelled" =
    body.disposition === "abandon" ? "cancelled" : "sealed";

  // Snapshot children before durable write — cascade after parent is terminal
  const children = [...E.children];

  // One @syncing.action with race re-check (epoch + running)
  if (!E.trySettleFromRunning(terminal, body.epoch)) {
    // Race: cancel/rebind won — do not clear bind if cancelTree may own cleanup
    if (E.state !== "running") {
      return { ok: false, code: "not_running" };
    }
    return { ok: false, code: "stale_epoch" };
  }

  // Clear surface wait after durable success (surface is not paid process work)
  if (bind.handle && !bind.handle.aborted) {
    bind.handle.abort(body.disposition);
  }
  orch.clearBind(E);
  orch.publishAwarenessBinds();

  // Parent terminal → cancel open children (§3.5)
  for (const child of children) {
    if (!isTerminal(child.state)) {
      orch.cancelTree(child, "parent_terminal");
    }
  }

  return { ok: true };
}
