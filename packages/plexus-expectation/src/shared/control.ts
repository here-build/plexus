/**
 * Steering / cancel are ephemeral presence data, not durable model state.
 *
 * Per-expectation lanes on the author's pen:
 *   `expectation:${uuid}:intents`       → {@link IntentLaneEntry}[]  (steer)
 *   `expectation:${uuid}:cancellation`  → {@link CancellationLaneEntry}[]  (envelope cancel)
 *
 * No central routing bag. Authors write the target's lane; the bound actor
 * reads intents; claim-owner admits cancellations. No acks. Retract = clear
 * the lane; reshape = rewrite the list. Rights = doc access.
 */

export type EndCause = "settled" | "surface" | "cancel" | "supervision" | "crash";

export type CancellationStrength = "cooperative" | "immediate";

export type SettleSurfaceDisposition = "allow" | "deny" | "abandon";

/** Wire field name for one expectation's standing steer intents. */
export function intentLaneField(uuid: string): string {
  return `expectation:${uuid}:intents`;
}

/** Wire field name for one expectation's standing cancel requests. */
export function cancellationLaneField(uuid: string): string {
  return `expectation:${uuid}:cancellation`;
}

/**
 * One standing steer on the intents lane. The lane field names the target —
 * no entity pointer on the wire.
 */
export type IntentLaneEntry = {
  readonly intentId: string;
  readonly body: unknown;
};

/**
 * One standing cancel on the cancellation lane. Body is typically
 * {@link CancellationRequestData}.
 */
export type CancellationLaneEntry = {
  readonly intentId: string;
  readonly body: unknown;
};

/**
 * Process-local scan record (lane + resolved target). Prefer lane reads for
 * product paths; this shape remains for tests that still name a target entity.
 */
export type IntentRecord = {
  readonly intentId: string;
  /** Model key on the session doc — never a uuid string. */
  readonly target: import("./models/Expectation.js").Expectation;
  readonly body: unknown;
  /** Present when the record came from the cancellation lane. */
  readonly kind?: "cancel";
};

/** `pew.requestCancellation` payload — carried verbatim as the cancel body. */
export type CancellationRequestData = {
  readonly strength?: CancellationStrength;
  readonly reason?: string;
  readonly [key: string]: unknown;
};
