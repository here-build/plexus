/**
 * PEW control-plane shapes (data only — no execution).
 *
 * Three flows: Expectation (work), Cancellation (system stop),
 * ExpectationAdjustmentIntent → ExpectationAdjustment (simplex beacon).
 * App domain never imports orchestration or runtime.
 */

// ── Cancellation (system stop — not an Adjustment) ───────────────────────

/** Strength ≈ SIGINT / SIGTERM. v1 product path exercises immediate only. */
export type CancellationStrength = "cooperative" | "immediate";

/**
 * Author/host request shape. Invokes cancelTree physics (C1); does not own exclusivity.
 */
export type CancellationRequest = {
  readonly type: "cancellation";
  /** Target Expectation wire identity (`E.uuid`). */
  readonly targetUuid: string;
  readonly strength: CancellationStrength;
  readonly reason?: string;
};

export type CancellationState =
  | "requested"
  | "applying"
  | "applied"
  | "withdrawn"
  | "refused";

/** Optional process-local request record (v1 may collapse apply to one frame). */
export type Cancellation = {
  readonly uuid: string;
  readonly targetUuid: string;
  readonly strength: CancellationStrength;
  readonly reason?: string;
  readonly state: CancellationState;
};

// ── Surface fulfillment (not Cancellation / not Adjustment) ──────────────

/** Surface settlement: abandon → cancelled; allow|deny → sealed. */
export type SettleSurfaceDisposition = "allow" | "deny" | "abandon";

/**
 * Settle a surface-mode Expectation. Claim owner validates claim + epoch, then seals or cancels.
 */
export type SettleSurfaceRequest = {
  readonly type: "settleSurface";
  /** Wire identity (`E.uuid`). */
  readonly uuid: string;
  /** Caller's observed `bindEpoch` — `stale_epoch` if mismatched. */
  readonly epoch: number;
  readonly disposition: SettleSurfaceDisposition;
};

/** @deprecated Prefer {@link SettleSurfaceRequest} */
export type SettleSurfaceIntent = SettleSurfaceRequest;

// ── ExpectationAdjustmentIntent → ExpectationAdjustment ──────────────────

/**
 * What the author spawns — pre-materialization form (C3).
 * `intentId` is author-minted for presence + correlation; never a Plexus uuid pretence.
 */
export type ExpectationAdjustmentIntent = {
  readonly type: "expectationAdjustment";
  /** Author-minted tracking id (presence key, chip id, withdraw-before-materialize). */
  readonly intentId: string;
  readonly targetUuid: string;
  readonly reshapeEpoch: number;
  /** Opaque to PEW — actor-domain only. */
  readonly body: unknown;
};

/**
 * Consumption lifecycle. Terminals: considered | withdrawn | refused.
 * `announced` = Intent on presence only; `queued` = durable Adjustment exists.
 */
export type AdjustmentConsumptionState =
  | "announced"
  | "queued"
  | "delivered"
  | "accepted"
  | "considered"
  | "withdrawing"
  | "withdrawn"
  | "refused";

export const ADJUSTMENT_TERMINALS = ["considered", "withdrawn", "refused"] as const satisfies readonly AdjustmentConsumptionState[];

export type AdjustmentTerminal = (typeof ADJUSTMENT_TERMINALS)[number];

// ── Deprecated cancel aliases (C1 maps to CancellationRequest) ───────────

/**
 * @deprecated Use {@link CancellationRequest} with `strength: "immediate"` and `targetUuid`.
 */
export type CancelIntent = {
  readonly type: "cancel";
  /** Target Expectation wire identity (`E.uuid`). */
  readonly uuid: string;
  readonly reason?: string;
};

/**
 * @deprecated Prefer named CancellationRequest | SettleSurfaceRequest | ExpectationAdjustmentIntent.
 */
export type PewIntent = CancelIntent | SettleSurfaceRequest;
