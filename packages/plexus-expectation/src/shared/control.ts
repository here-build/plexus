/**
 * Control-plane value types shared by authors, observers, and the kernel.
 *
 * Steering intents are EPHEMERAL by design — they live in the author's own
 * presence record, never in the durable model. The restart guarantee is the
 * admission rule, not presence lifetime: an intent targets an Expectation
 * uuid, admission requires that uuid to be locally bound right now, and
 * one-execution guarantees a uuid never runs again — so a stale intent has no
 * execution it could ever reach except the one it was written for.
 *
 * There are NO epochs and NO revision correlation: outcomes correlate by
 * `intentId` only. An author needing to know which body revision was honored
 * retracts and mints a new intentId — versioning machinery on a channel that
 * promises nothing buys nothing.
 *
 * Steering rights = doc access. Admission is purely mechanical; any peer that
 * can write the session's presence can author intents. Finer-grained
 * authorization is a host-layer concern: the host filters which peers'
 * presence it feeds the kernel.
 */

/** Terminal discriminator — downstream policy keys on (state, endCause), never on state alone. */
export type EndCause = "settled" | "surface" | "cancel" | "supervision" | "crash";

export type CancellationStrength = "cooperative" | "immediate";

export type SettleSurfaceDisposition = "allow" | "deny" | "abandon";

/** One steering request, as written in the author's own presence record. */
export type IntentRecord = {
  readonly intentId: string;
  readonly targetUuid: string;
  readonly body: unknown;
};

export type IntentRefusalCode = "target_terminal" | "target_unbound" | "duplicate_intent_id" | "messages_not_accepted";

export type IntentAckState = "admitted" | "considered" | "dropped" | `refused:${IntentRefusalCode}`;

/** Kernel acknowledgment, as mirrored in the kernel's own presence record. */
export type IntentAck = {
  readonly intentId: string;
  readonly state: IntentAckState;
};
