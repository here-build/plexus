/**
 * Author / UI → claim owner action shapes (data only — no execution).
 *
 * Claim owner applies these via runtime (`Orchestrator.cancelTree`, `settleSurface`).
 * App domain never imports orchestration or runtime.
 */

/** Surface settlement dispositions (§5.4): abandon → cancelled; allow|deny → sealed. */
export type SettleSurfaceDisposition = "allow" | "deny" | "abandon";

/**
 * Request cancellation of a named work unit.
 * Claim owner runs abort-first `Orchestrator.cancelTree` on the resolved Expectation.
 */
export type CancelIntent = {
  readonly type: "cancel";
  /** Wire identity of the Expectation (`E.uuid`). */
  readonly uuid: string;
  readonly reason?: string;
};

/**
 * Request settlement of a surface-mode Expectation (approve / deny / abandon).
 * Claim owner validates claim + epoch, then seals or cancels.
 */
export type SettleSurfaceIntent = {
  readonly type: "settleSurface";
  /** Wire identity of the Expectation (`E.uuid`). */
  readonly uuid: string;
  /** Caller's observed `bindEpoch` — stale_epoch if mismatched. */
  readonly epoch: number;
  readonly disposition: SettleSurfaceDisposition;
};

/** Closed union of author/UI intents toward the claim owner. */
export type PewIntent = CancelIntent | SettleSurfaceIntent;
