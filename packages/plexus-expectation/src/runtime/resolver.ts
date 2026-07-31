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
 * Wire/log identity only. Local claim maps use the Expectation entity as key.
 */
export type WorkIdentity = {
  readonly uuid: string;
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
 * Module start function. Receives snapshot input + emit; may complete sync
 * before returning (T19). Must honor `input.signal` for paid work.
 *
 * First slice: **synchronous** return only (Promise handles are refused).
 * Return a handle if the module owns extra teardown; otherwise the host wraps
 * the AbortController as the handle.
 */
export type StartResolverFn = (
  input: ResolverStartInput,
  emit: EmitFn,
) => ResolverHandle | void;

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
