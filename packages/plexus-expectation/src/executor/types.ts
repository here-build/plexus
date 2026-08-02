import type { LaunchDefinition, LaunchDefinitionSnapshot } from "../shared/models/LaunchDefinition.js";

/**
 * Process-plane contracts between kernel, loader, and actor (design.md §5).
 *
 * SIMPLEX LAW: the kernel never calls into an actor — the AbortSignal in
 * `LaunchContext` is the only kernel-initiated signal, and steering reaches
 * the actor as observable mailbox DATA it reads at its own pace. Everything
 * the actor sends (settlement, control outcomes, presence updates) is
 * fire-and-forget; no channel carries a response to another channel.
 */

export type Settlement<TResult> =
  | { readonly outcome: "complete"; readonly result: TResult }
  | { readonly outcome: "fail"; readonly reason: unknown };

export type IntentOutcome = {
  readonly intentId: string;
  readonly outcome: "considered" | "dropped";
};

export type MailboxEntry = {
  readonly intentId: string;
  /** Current revision — in-place author edits replace it; no revision correlation exists. */
  readonly body: unknown;
};

/** Read-only observable list; the kernel adds and removes entries, the actor only reads. */
export type MailboxView = {
  readonly entries: readonly MailboxEntry[];
};

/** Mints at most one awareness client per spawn, on the session hub. */
export type PresencePort = {
  mintClient(): ActorPresenceClient;
};

export type ActorPresenceClient = {
  readonly clientID: number;
  setReport(frame: unknown): void;
  destroy(): void;
};

/** Opaque append sink for actor/loader audit trails; the core never reads it back. */
export type LogPort = {
  append(line: string): void;
};

export type LaunchContext<TInput = unknown> = {
  readonly input: TInput;
  readonly definition: LaunchDefinitionSnapshot;
  readonly signal: AbortSignal;
  readonly presence: PresencePort;
  readonly mailbox: MailboxView;
  readonly log?: LogPort;
};

/**
 * The kernel's whole view of a live execution. Generically typed on purpose:
 * the kernel is generic over triads — typing re-establishes entity-side
 * (`applySettlement`) and actor-side (`ExpectationActor` generics). A
 * generically-typed kernel is not a missing feature (design.md §3).
 */
export type ActorHandle = {
  readonly settled: Promise<Settlement<unknown>>;
  /** Awareness client on the session hub; 0 = no presence — treat as none, never resolve. */
  readonly clientId: number;
  /** Sync settlement buffer, set at emit — folds consult it first (SETTLEMENT PREFERENCE, design.md §7). */
  settlement(): Settlement<unknown> | null;
  /** Kernel-side buffer of the last successfully-serialized frame (LAST REPORT LAW, design.md §6). */
  lastReport(): unknown | null;
  onControlOutcome(sink: (outcome: IntentOutcome) => void): void;
};

export type PlanResolution =
  | { readonly status: "missing" }
  | { readonly status: "refused"; readonly def: LaunchDefinition }
  | { readonly status: "bound"; readonly def: LaunchDefinition };

export type OpResult<C extends string = string> = { readonly ok: true } | { readonly ok: false; readonly code: C };

export type CancellationErrorCode = "not_claim_owner" | "target_terminal" | "cooperative_not_implemented";
export type CancellationResult = OpResult<CancellationErrorCode>;

export type SettleSurfaceErrorCode = "not_claim_owner" | "not_running" | "not_surface";
export type SettleSurfaceResult = OpResult<SettleSurfaceErrorCode>;

/** Per-plan loader health, advertised in the kernel's presence (design.md §9). */
export type LoaderHealth = "loading" | "loaded" | `failed:${string}`;

/** Snapshot the kernel publishes into its own presence record. */
export type KernelPresenceStatus = {
  readonly binds: readonly { readonly uuid: string }[];
  readonly loaders: Readonly<Record<string, LoaderHealth>>;
  readonly acks: readonly { readonly intentId: string; readonly state: string }[];
};
