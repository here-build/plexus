/**
 * startResolver contract (§3.3 / §5.3).
 *
 * Resolver body receives snapshots + AbortSignal only — never the session doc
 * and never a mutable Expectation entity.
 */

import type { LaunchMode, ProgressMode } from "../orchestration/launch-definition.js";

/** Plain snapshot of {@link import("../orchestration/launch-definition.js").LaunchDefinition}. */
export type LaunchDefinitionSnapshot = {
  readonly launchMode: LaunchMode;
  readonly acceptsMessages: boolean;
  readonly emitsProgress: boolean;
  readonly progressMode: ProgressMode;
};

/** Opaque progress payload — product interprets; PEW core only fences + forwards. */
export type ProgressPatch = unknown;

/** Resolver → claim owner emit messages (§3.3). */
export type ResolverEmit =
  | { readonly type: "progress"; readonly epoch: number; readonly patch: ProgressPatch }
  | { readonly type: "complete"; readonly epoch: number; readonly disposition?: unknown }
  | { readonly type: "fail"; readonly epoch: number; readonly reason: unknown };

export type EmitFn = (message: ResolverEmit) => void;

/**
 * Local start identity — kind only.
 *
 * Process-local claim maps key by the Expectation entity. Wire uuid is **not**
 * snapped here: resolve `E.uuid` only at sync edges (awareness, journal, UI
 * intents). Eager uuid in the activate/start loop is the wrong shape.
 */
export type WorkIdentity = {
  readonly kind: string;
};

/** Input to every non-surface resolver start (§3.3). */
export type ResolverStartInput = {
  readonly work: WorkIdentity;
  readonly epoch: number;
  readonly definition: LaunchDefinitionSnapshot;
  readonly input: unknown;
  readonly signal: AbortSignal;
};

/**
 * Live resolver control. Claim owner calls `abort` before durable cancel.
 * Surface waits use the same shape (no OS process).
 */
export type ResolverHandle = {
  abort(reason?: unknown): void;
  /** True after abort (or natural end that marked aborted). */
  readonly aborted: boolean;
};

/**
 * Refuse Promise / thenable returns at the type level (`async` start → `never`).
 * Hosts wrap async work outside PEW; the claim-owner loop is sync.
 */
type SyncOnly<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/**
 * Module start function. Receives snapshot input + emit; may complete sync
 * before returning. Must honor `input.signal` for paid work.
 *
 * Return type is {@link SyncOnly} — `async` functions and Promise-returning
 * starters are unassignable. Return a handle if the module owns extra teardown;
 * otherwise the host wraps the AbortController as the handle.
 */
export type StartResolverFn = (
  input: ResolverStartInput,
  emit: EmitFn,
) => SyncOnly<ResolverHandle | void>;

/** Build a handle tied to an AbortController (fires signal on abort). */
export function handleFromController(controller: AbortController): ResolverHandle {
  return {
    get aborted() {
      return controller.signal.aborted;
    },
    abort(reason?: unknown) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
  };
}

/** Snapshot a durable LaunchDefinition for resolver input. */
export function snapshotDefinition(def: {
  launchMode: LaunchMode;
  acceptsMessages: boolean;
  emitsProgress: boolean;
  progressMode: ProgressMode;
}): LaunchDefinitionSnapshot {
  return {
    launchMode: def.launchMode,
    acceptsMessages: def.acceptsMessages,
    emitsProgress: def.emitsProgress,
    progressMode: def.progressMode,
  };
}
