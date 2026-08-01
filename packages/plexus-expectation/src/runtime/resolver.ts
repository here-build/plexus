/**
 * startResolver contract.
 *
 * Resolver body receives snapshots + AbortSignal only — never the session doc
 * and never a mutable Expectation entity.
 */

import type { ProgressPatch } from "../app/progress-plane.js";
import type { LaunchDefinitionSnapshot } from "../orchestration/launch-definition.js";

export type { ProgressPatch, LaunchDefinitionSnapshot };

export type ResolverEmit =
  | { readonly type: "progress"; readonly epoch: number; readonly patch: ProgressPatch }
  | { readonly type: "complete"; readonly epoch: number; readonly disposition?: unknown }
  | { readonly type: "fail"; readonly epoch: number; readonly reason: unknown };

export type EmitFn = (message: ResolverEmit) => void;

/**
 * Simplex adjustment beacon snapshot (no reply channel).
 * intentId correlates Intent/presence; adjustmentUuid is Plexus entity id after materialize.
 */
export type AdjustmentSnapshot = {
  readonly intentId: string;
  readonly adjustmentUuid: string;
  readonly targetUuid: string;
  readonly reshapeEpoch: number;
  readonly body: unknown;
};

/** Consumption lifecycle acks — not product replies; do not write Expectation (C2). */
export type ResolverControlAck =
  | { readonly type: "ackWillConsider"; readonly intentId: string; readonly reshapeEpoch: number }
  | { readonly type: "markConsidered"; readonly intentId: string; readonly reshapeEpoch: number }
  | { readonly type: "ackDropped"; readonly intentId: string; readonly reshapeEpoch: number };

export type ControlAckFn = (ack: ResolverControlAck) => void;

export type ResolverStartInput = {
  readonly kind: string;
  readonly epoch: number;
  readonly definition: LaunchDefinitionSnapshot;
  readonly input: unknown;
  readonly signal: AbortSignal;
};

/**
 * Live resolver control. Claim owner calls `abort` before durable cancel.
 * Optional adjustment methods are simplex inbound (default no-ops).
 */
export type ResolverHandle = {
  abort(reason?: unknown): void;
  readonly aborted: boolean;
  deliverAdjustment?(snapshot: AdjustmentSnapshot): void;
  retractAdjustment?(
    key: { intentId: string } | { adjustmentUuid: string },
    reshapeEpoch: number,
  ): void;
  reshapeAdjustment?(snapshot: AdjustmentSnapshot): void;
};

/**
 * Module start function. Sync return only (`async` is unassignable).
 * Must honor `input.signal` for paid work.
 * Optional `control` receives simplex adjustment acks (C2: never write Expectation here in PEW).
 */
export type StartResolverFn = (
  input: ResolverStartInput,
  emit: EmitFn,
  control?: ControlAckFn,
) => ResolverHandle | void;
