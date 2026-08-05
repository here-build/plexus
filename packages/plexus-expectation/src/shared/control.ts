/**
 * Steering is ephemeral presence data, not durable model state.
 *
 * Admission is "target open + locally bound right now" + one-execution — so a
 * stale intent in an author's presence can never reach a future run. There are
 * no acks: the kernel's only responsibility is mirroring standing intents into
 * the actor's inbox; what the actor does with an entry is its own decision,
 * observable through the report stream and durable plane. No epochs; retract =
 * remove; reshape = edit body in place. Rights = doc access; finer auth is
 * host-layer.
 */

export type EndCause = "settled" | "surface" | "cancel" | "supervision" | "crash";

export type CancellationStrength = "cooperative" | "immediate";

export type SettleSurfaceDisposition = "allow" | "deny" | "abandon";

export type IntentRecord = {
  readonly intentId: string;
  /** Model key on the session doc — never a uuid string. */
  readonly target: import("./models/Expectation.js").Expectation;
  readonly body: unknown;
  /**
   * Envelope verb. Absent/`"steer"` = product steering → target's mailbox.
   * `"cancel"` = kernel-handled cancellation request — bypasses
   * acceptsMessages and the running/bound gate (any open target).
   */
  readonly kind?: "steer" | "cancel";
};

/** `pew.requestCancellation` payload — carried verbatim as the intent body. */
export type CancellationRequestData = {
  readonly strength?: CancellationStrength;
  readonly reason?: string;
  readonly [key: string]: unknown;
};

