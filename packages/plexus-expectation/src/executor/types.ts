import type { Expectation, InputOf, IntentOf } from "../shared/models/Expectation.js";
import type { LaunchDefinition, LaunchDefinitionSnapshot } from "../shared/models/LaunchDefinition.js";
import type { PresencePort } from "../shared/presence.js";

/**
 * Process-plane contracts (kernel ↔ loader ↔ actor).
 *
 * SIMPLEX: the kernel never calls into an actor — only AbortSignal is
 * kernel-initiated. Settlement, control outcomes, and presence writes are
 * fire-and-forget. Steering is mailbox data the actor reads at its own pace.
 */

export type Settlement<TResult> =
  | { readonly outcome: "complete"; readonly result: TResult }
  | { readonly outcome: "fail"; readonly reason: unknown };

export type IntentOutcome = {
  readonly intentId: string;
  readonly outcome: "considered" | "dropped";
};

export type MailboxEntry<TIntent = unknown> = {
  readonly intentId: string;
  /** Current body; in-place reshape replaces it — no revision id. */
  readonly body: TIntent;
};

/**
 * Kernel-owned list, actor-read-only. Iterate a copy: the kernel splices in
 * the same turn an outcome lands.
 */
export type MailboxView<TIntent = unknown> = {
  readonly entries: readonly MailboxEntry<TIntent>[];
};

export type LaunchContext<E extends Expectation<any, any, never> = Expectation> = {
  readonly input: InputOf<E>;
  readonly definition: LaunchDefinitionSnapshot;
  readonly signal: AbortSignal;
  readonly presence: PresencePort;
  readonly mailbox: MailboxView<IntentOf<E>>;
};

/**
 * Kernel view of a live execution. Generics re-establish at entity
 * (`applySettlement`) and actor sides — the kernel boundary stays `unknown`.
 */
export type ActorHandle = {
  readonly settled: Promise<Settlement<unknown>>;
  /** 0 = unassigned (PEW never mints 0; plexus-internal). */
  readonly clientId: number;
  /** Sync buffer at emit — folds consult this before the settlement promise. */
  settlement(): Settlement<unknown> | null;
  /** Last good serialized frame for the terminal fold. */
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

export {
  type ActorPresenceClient,
  type ClaimPresenceStatus,
  type CatalogPresenceStatus,
  type LoaderHealth,
  type LoaderCapability,
  type PresencePort,
} from "../shared/presence.js";
