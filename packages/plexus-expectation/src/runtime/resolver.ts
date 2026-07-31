/**
 * startResolver contract.
 *
 * Resolver body receives snapshots + AbortSignal only — never the session doc
 * and never a mutable Expectation entity.
 */

import type { LaunchMode, ProgressMode } from "../orchestration/launch-definition.js";

/**
 * Independent copy of plan-entry scalars for resolver start.
 * Not a Plexus model — plain data so resolvers cannot touch the session doc.
 */
export class LaunchDefinitionSnapshot {
  readonly launchMode: LaunchMode;
  readonly acceptsMessages: boolean;
  readonly emitsProgress: boolean;
  readonly progressMode: ProgressMode;

  constructor(init: {
    launchMode: LaunchMode;
    acceptsMessages: boolean;
    emitsProgress: boolean;
    progressMode: ProgressMode;
  }) {
    this.launchMode = init.launchMode;
    this.acceptsMessages = init.acceptsMessages;
    this.emitsProgress = init.emitsProgress;
    this.progressMode = init.progressMode;
  }
}

/** Opaque progress payload — product interprets; PEW core only fences + forwards. */
export type ProgressPatch = unknown;

export type ResolverEmit =
  | { readonly type: "progress"; readonly epoch: number; readonly patch: ProgressPatch }
  | { readonly type: "complete"; readonly epoch: number; readonly disposition?: unknown }
  | { readonly type: "fail"; readonly epoch: number; readonly reason: unknown };

export type EmitFn = (message: ResolverEmit) => void;

export type ResolverStartInput = {
  readonly kind: string;
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
  readonly aborted: boolean;
};

/**
 * Module start function. Sync return only (`async` is unassignable).
 * Must honor `input.signal` for paid work. Return a handle if the module owns
 * extra teardown; otherwise the host wraps the AbortController.
 */
export type StartResolverFn = (
  input: ResolverStartInput,
  emit: EmitFn,
) => ResolverHandle | void;
