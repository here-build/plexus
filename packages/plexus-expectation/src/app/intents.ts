/**
 * Author / UI → claim owner action shapes (data only — no execution).
 * App domain never imports orchestration or runtime.
 */

/** Surface settlement: abandon → cancelled; allow|deny → sealed. */
export type SettleSurfaceDisposition = "allow" | "deny" | "abandon";

/**
 * Cancel a named work unit. Claim owner runs abort-first `cancelTree` on the resolved Expectation.
 */
export type CancelIntent = {
  readonly type: "cancel";
  /** Wire identity (`E.uuid`). */
  readonly uuid: string;
  readonly reason?: string;
};

/**
 * Settle a surface-mode Expectation. Claim owner validates claim + epoch, then seals or cancels.
 */
export type SettleSurfaceIntent = {
  readonly type: "settleSurface";
  /** Wire identity (`E.uuid`). */
  readonly uuid: string;
  /** Caller's observed `bindEpoch` — `stale_epoch` if mismatched. */
  readonly epoch: number;
  readonly disposition: SettleSurfaceDisposition;
};

export type PewIntent = CancelIntent | SettleSurfaceIntent;
