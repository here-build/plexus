/**
 * Claim-owner runtime (plain class, not @syncing).
 *
 * `activating` / `binding` keyed by Expectation entity. Construct at lease
 * install; never in a model constructor. Product hosts subclass and implement
 * the abstract surface.
 */

import type {
  AdjustmentSnapshot,
  ProgressPatch,
  ResolverControlAck,
  ResolverEmit,
  ResolverHandle,
  StartResolverFn,
} from "./resolver.js";
import type { ExpectationExecution, LaunchContext, LaunchRuntime } from "./execution.js";
import { HostPortLaunchRuntime } from "./execution.js";
import { Expectation } from "../app/expectation.js";
import { type AdjustmentBag, ExpectationAdjustment } from "../app/expectation-adjustment.js";
import type { CancellationStrength, ExpectationAdjustmentIntent, SettleSurfaceDisposition } from "../app/control.js";
import { isAdjustmentTerminal, shouldRedeliverAdjustment, shouldRetractOnRebind } from "../app/adjustment-lifecycle.js";
import { isTerminal } from "../app/lifecycle.js";
import type { LaunchDefinition } from "../orchestration/launch-definition.js";
import type { Orchestration } from "../orchestration/orchestration.js";

export type BindEntry = {
  /** Live execution handle (ExpectationExecution). */
  handle: ExpectationExecution | null;
  epoch: number;
};

/** Plan resolve outcome for a kind. */
export type PlanResolution =
  | { readonly status: "missing" }
  | { readonly status: "refused"; readonly def: LaunchDefinition }
  | { readonly status: "bound"; readonly def: LaunchDefinition };

/** Cap on unexpected rebinds before activation fails with rebind_exhausted. */
export const DEFAULT_MAX_REBINDS = 3;

export type MarkAwaitingRebindOpts = {
  readonly reason?: unknown;
  /** True for unexpected resolver death; false for lease_yield / claim-orphan class. */
  readonly incrementRebind: boolean;
};

export type SettleSurfaceBody = {
  readonly epoch: number;
  readonly disposition: SettleSurfaceDisposition;
};

export type SettleSurfaceErrorCode = "not_claim_owner" | "not_running" | "stale_epoch";

export type SettleSurfaceResult = { readonly ok: true } | { readonly ok: false; readonly code: SettleSurfaceErrorCode };

export type CancellationResult =
  | { readonly ok: true; readonly state: "applied" }
  | {
      readonly ok: false;
      readonly code: "not_claim_owner" | "target_terminal" | "cooperative_not_implemented";
    };

export type MaterializeAdjustmentResult =
  | { readonly ok: true; readonly adjustment: ExpectationAdjustment }
  | {
      readonly ok: false;
      readonly code: "not_claim_owner" | "target_terminal" | "duplicate_intent_id";
    };

export type AdjustmentOpResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "not_claim_owner"
        | "not_found"
        | "stale_epoch"
        | "withdraw_refused"
        | "promote_refused"
        | "target_not_bound";
    };

const ACTIVATE_STATES: ReadonlySet<string> = new Set(["declared", "missing", "refused", "awaiting_rebind"]);

export function* walkExpectationForest(roots: readonly Expectation[]): Generator<Expectation> {
  const seen = new Set<Expectation>();
  const walk = function* (E: Expectation): Generator<Expectation> {
    if (seen.has(E)) return;
    seen.add(E);
    yield E;
    for (const child of E.children) {
      yield* walk(child);
    }
  };
  for (const root of roots) {
    yield* walk(root);
  }
}

function collectReachable(roots: readonly Expectation[]): Set<Expectation> {
  return new Set(walkExpectationForest(roots));
}

/** Non-terminal under a terminal Expectation parent. */
function isTreeOrphan(E: Expectation): boolean {
  if (isTerminal(E.state)) return false;
  const parent = E.parent;
  if (parent == null) return false;
  if (!(parent instanceof Expectation)) return false;
  return isTerminal(parent.state);
}

/**
 * Non-terminal and not reachable from openWork roots.
 * Prefer Plexus `isDetached` when materialized.
 */
function isForestOrphan(E: Expectation, reachable: ReadonlySet<Expectation>): boolean {
  if (isTerminal(E.state)) return false;
  if (reachable.has(E)) return false;
  try {
    if (E.isDetached) return true;
  } catch {
    // unmaterialized — fall through to reachable-set rule
  }
  return true;
}

/**
 * Claim-owner runtime. Process-local maps only; durable writes go through
 * Expectation `@syncing.action` methods.
 */
export abstract class Orchestrator {
  readonly activating: Set<Expectation> = new Set();
  readonly binding: Map<Expectation, BindEntry> = new Map();
  /** Plans currently running bootstrapRunner (H5). */
  readonly #bootstrapping: Set<LaunchDefinition> = new Set();
  readonly maxRebinds: number;

  constructor(opts?: { maxRebinds?: number }) {
    this.maxRebinds = opts?.maxRebinds ?? DEFAULT_MAX_REBINDS;
  }

  // ── Abstract host surface ──────────────────────────────────────────────

  abstract getOrchestration(): Orchestration;

  /**
   * Process-local launcher for this plan (claim-owner only).
   * Undefined → cannot host (refused) or not yet registered (wait — missing starter).
   * Dual path: HostPortLaunchRuntime (tools/completion) vs pure runners (LocalAcp).
   */
  abstract getLaunchRuntime(def: LaunchDefinition): LaunchRuntime | undefined;

  /**
   * @deprecated Prefer {@link getLaunchRuntime}. Legacy mode floor for tests.
   */
  supportsStrategy(strategy: string): boolean {
    return true;
  }

  /**
   * @deprecated Prefer HostPortLaunchRuntime + kind starters inside the runtime.
   */
  resolveModule(_kind: string, _strategy: string): StartResolverFn | undefined {
    return undefined;
  }

  /**
   * Late-wire a starter. Default no-op; HostPort hosts override.
   * Call reconcile after register so waiting open work can activate.
   */
  registerModule(_key: string, _start: StartResolverFn): void {
    /* optional */
  }

  /** After async bootstrapRunner completes — host typically reconcile(). */
  protected onLaunchRuntimeReady(): void {
    /* host overrides */
  }

  abstract isClaimOwner(): boolean;
  abstract getOpenWorkRoots(): readonly Expectation[];

  /**
   * Extra candidates for forest-orphan scan. Empty = openWork only.
   */
  abstract walkCandidates(): Iterable<Expectation>;

  abstract hasLiveClaimPeerBind(E: Expectation): boolean;
  abstract snapshotProductFields(E: Expectation): unknown;
  abstract publishAwarenessBinds(): void;

  /**
   * Open adjustment bag (product root). Default null — hosts without adjustments
   * skip materialize/drain. Tests override via {@link PewTestHost} or subclass.
   */
  getAdjustmentBag(): AdjustmentBag | null {
    return null;
  }

  /**
   * Default: forward to {@link Expectation.reportProgress} on the Expectation's
   * live awareness client. Respects plan `emitsProgress` + `progressMode`.
   */
  applyProgress(E: Expectation, patch: ProgressPatch): void {
    const plan = this.resolvePlan(E.kind);
    if (plan.status === "bound") {
      if (!plan.def.emitsProgress || plan.def.progressMode === "none") return;
      E.reportProgress(patch, plan.def.progressMode);
      return;
    }
    E.reportProgress(patch, "lww");
  }

  // ── Bind map (subclass + product repair) ───────────────────────────────

  protected setBind(E: Expectation, entry: BindEntry): void {
    this.binding.set(E, entry);
  }

  protected clearBind(E: Expectation): void {
    this.binding.delete(E);
  }

  protected clearActivating(E: Expectation): void {
    this.activating.delete(E);
  }

  /**
   * Drop process-local claim for E (journal repair, claim-orphan setup).
   * Does not change durable lifecycle.
   */
  releaseLocalBind(E: Expectation): void {
    this.clearBind(E);
    this.clearActivating(E);
  }

  // ── Plan / handle helpers ──────────────────────────────────────────────

  /**
   * Pure plan resolution (also available as {@link Orchestrator.resolvePlan} static
   * for product tests without a full host).
   */
  resolvePlan(kind: string): PlanResolution {
    return Orchestrator.resolvePlan(kind, this.getOrchestration(), (def) => this.getLaunchRuntime(def) != null);
  }

  /**
   * kind + plan actors + host runtime presence → missing | refused | bound.
   * canHost false = refused (no LaunchRuntime for this def class).
   */
  static resolvePlan(
    kind: string,
    orchestration: Orchestration,
    canHost: (def: LaunchDefinition) => boolean,
  ): PlanResolution {
    const def = orchestration.actors.get(kind);
    if (def === undefined) {
      return { status: "missing" };
    }
    if (!canHost(def)) {
      return { status: "refused", def };
    }
    return { status: "bound", def };
  }

  /** AbortController → provisional ExpectationExecution (abort only). */
  protected executionFromController(controller: AbortController): ExpectationExecution {
    return {
      get aborted() {
        return controller.signal.aborted;
      },
      abort(reason?: unknown) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      },
      async emit() {
        /* provisional — real exec replaces after run */
      },
      async control() {
        /* provisional */
      },
      deliverAdjustment() {
        /* no-op until real exec */
      },
      retractAdjustment() {
        /* no-op */
      },
      reshapeAdjustment() {
        /* no-op */
      },
    };
  }

  // ── Activate ───────────────────────────────────────────────────────────

  /**
   * Single-flight activate. Idempotent for healthy running binds.
   * Never takes durable `running` without a resolved starter (all modes,
   * including surface — register a mode-level starter). Missing starter waits
   * for {@link registerModule} + {@link reconcile}.
   */
  activate(E: Expectation): void {
    if (isTerminal(E.state)) return;
    if (!this.isClaimOwner()) return;
    if (this.activating.has(E)) return;

    const existing = this.binding.get(E);
    if (E.state === "running" && existing) {
      if (this.#isHealthy(existing)) return;
      this.onResolverDeath(E, "unhealthy_bind");
      return;
    }

    if (this.#isRebindExhausted(E)) {
      if (E.state === "awaiting_rebind") {
        E.transitionState("failed");
      }
      this.clearBind(E);
      this.publishAwarenessBinds();
      return;
    }

    this.activating.add(E);
    try {
      const outcome = this.resolvePlan(E.kind);

      if (outcome.status === "missing") {
        if (isTerminal(E.state)) return;
        E.transitionState("missing");
        return;
      }
      if (outcome.status === "refused") {
        if (isTerminal(E.state)) return;
        E.transitionState("refused");
        return;
      }

      const def = outcome.def;
      if (isTerminal(E.state)) return;

      const runtime = this.getLaunchRuntime(def);
      if (!runtime) return; // wait for host register (H5 cold path)

      if (!runtime.isReady(def)) {
        if (!this.#bootstrapping.has(def)) {
          this.#bootstrapping.add(def);
          void runtime
            .bootstrap(def)
            .catch(() => {
              /* bootstrap failure: leave not-ready; next reconcile may refuse */
            })
            .finally(() => {
              this.#bootstrapping.delete(def);
              this.onLaunchRuntimeReady();
            });
        }
        return;
      }

      // H5: missing starter — wait without beginRunning (no durable failed).
      if (!runtime.canRun(def, E.kind)) return;

      const epoch = E.beginRunning();
      if (E.state !== "running" || epoch === 0) return;

      // Live half: one awareness clientId for this invocation (generator face).
      E.attachLivePresence();

      const controller = new AbortController();
      const provisional = this.executionFromController(controller);
      this.setBind(E, { handle: provisional, epoch });
      this.publishAwarenessBinds();

      try {
        const ctx: LaunchContext = {
          kind: E.kind,
          epoch,
          input: this.snapshotProductFields(E),
          signal: controller.signal,
          definition: def.toSnapshot(),
        };
        const bodyExec = runtime.run(def, ctx, {
          applyEmit: (message) => this.applyEmit(E, message),
          applyControl: (ack) => {
            this.applyControlAck(ack);
          },
        });
        // Chain abort to activate's AbortController so signal aborts paid work (T15/T20).
        const exec: ExpectationExecution = {
          get aborted() {
            return bodyExec.aborted || controller.signal.aborted;
          },
          abort(reason?: unknown) {
            bodyExec.abort(reason);
            provisional.abort(reason);
          },
          emit: (m) => bodyExec.emit(m),
          control: (a) => bodyExec.control(a),
          deliverAdjustment: bodyExec.deliverAdjustment?.bind(bodyExec),
          retractAdjustment: bodyExec.retractAdjustment?.bind(bodyExec),
          reshapeAdjustment: bodyExec.reshapeAdjustment?.bind(bodyExec),
        };
        const bind = this.binding.get(E);
        if (bind !== undefined && bind.epoch === epoch && E.state === "running") {
          this.setBind(E, { handle: exec, epoch });
          this.drainOpenAdjustments(E);
        }
      } catch {
        this.#failStart(E, controller);
      }
    } finally {
      this.clearActivating(E);
    }
  }

  #failStart(E: Expectation, controller: AbortController): void {
    if (!controller.signal.aborted) {
      controller.abort("start_failed");
    }
    E.clearProgress();
    this.clearBind(E);
    this.publishAwarenessBinds();
    if (!isTerminal(E.state)) {
      E.transitionState("failed");
    }
  }

  #isHealthy(bind: BindEntry): boolean {
    if (bind.handle == null) return true;
    return !bind.handle.aborted;
  }

  #isRebindExhausted(E: Expectation): boolean {
    return E.state === "awaiting_rebind" && E.rebindCount > this.maxRebinds;
  }

  // ── Cancel / emit / settle / rebind ────────────────────────────────────

  /**
   * Abort-before-durable cancel of owned subtree.
   * System + product paths may call this directly (C1 multi-writer).
   */
  cancelTree(root: Expectation, reason?: unknown): void {
    const nodes = this.#collectOwnedSubtree(root);

    for (const node of nodes) {
      const bind = this.binding.get(node);
      if (bind && node.state === "running" && bind.handle && !bind.handle.aborted) {
        bind.handle.abort(reason);
      }
    }

    root.cancelSubtreeDurable();

    for (const node of nodes) {
      try {
        this.#refuseAdjustmentsForTarget(node.uuid);
      } catch {
        // unmaterialized E — no durable uuid yet
      }
      node.clearProgress();
      this.clearBind(node);
      this.clearActivating(node);
    }
    this.publishAwarenessBinds();
  }

  /**
   * Explicit Cancellation face — invokes the same physics as {@link cancelTree} (C1).
   * Does not replace interrupt/orphan/parent writers.
   */
  requestCancellation(
    target: Expectation,
    opts: { strength: CancellationStrength; reason?: unknown },
  ): CancellationResult {
    if (!this.isClaimOwner()) {
      return { ok: false, code: "not_claim_owner" };
    }
    if (isTerminal(target.state)) {
      return { ok: false, code: "target_terminal" };
    }
    if (opts.strength === "cooperative") {
      return { ok: false, code: "cooperative_not_implemented" };
    }
    this.cancelTree(target, opts.reason ?? "cancellation");
    return { ok: true, state: "applied" };
  }

  // ── ExpectationAdjustment (simplex) ────────────────────────────────────

  /**
   * Materialize Intent → durable Adjustment (C3: intentId copied; uuid auto).
   */
  materializeAdjustment(intent: ExpectationAdjustmentIntent, bag: AdjustmentBag): MaterializeAdjustmentResult {
    if (!this.isClaimOwner()) {
      return { ok: false, code: "not_claim_owner" };
    }
    for (const existing of bag.adjustments) {
      if (existing.intentId === intent.intentId && !isAdjustmentTerminal(existing.consumption)) {
        return { ok: false, code: "duplicate_intent_id" };
      }
    }
    const target = this.#findExpectationByUuid(intent.targetUuid);
    if (target && isTerminal(target.state)) {
      return { ok: false, code: "target_terminal" };
    }

    const adj = new ExpectationAdjustment();
    ExpectationAdjustment.fillFromIntent(adj, intent);
    bag.addAdjustment(adj);
    return { ok: true, adjustment: adj };
  }

  deliverAdjustment(E: Expectation, adj: ExpectationAdjustment): AdjustmentOpResult {
    if (!this.isClaimOwner()) return { ok: false, code: "not_claim_owner" };
    if (adj.targetUuid !== E.uuid) return { ok: false, code: "not_found" };
    if (isAdjustmentTerminal(adj.consumption) || adj.consumption === "withdrawing") {
      return { ok: false, code: "withdraw_refused" };
    }
    const bind = this.binding.get(E);
    if (!bind?.handle || E.state !== "running") {
      return { ok: false, code: "target_not_bound" };
    }
    if (adj.consumption === "queued" || adj.consumption === "announced") {
      adj.transitionConsumption("delivered");
    }
    const snapshot = this.#adjustmentSnapshot(adj);
    bind.handle.deliverAdjustment?.(snapshot);
    return { ok: true };
  }

  retractAdjustment(key: { intentId: string } | { adjustmentUuid: string }, reshapeEpoch: number): AdjustmentOpResult {
    if (!this.isClaimOwner()) return { ok: false, code: "not_claim_owner" };
    const adj = this.#findAdjustment(key);
    if (!adj) return { ok: false, code: "not_found" };
    if (adj.consumption === "considered") {
      return { ok: false, code: "withdraw_refused" };
    }
    if (reshapeEpoch < adj.reshapeEpoch) {
      return { ok: false, code: "stale_epoch" };
    }
    if (!adj.markWithdrawing()) {
      return { ok: false, code: "withdraw_refused" };
    }
    if (adj.consumption === "withdrawing") {
      const E = this.#findExpectationByUuid(adj.targetUuid);
      const bind = E ? this.binding.get(E) : undefined;
      bind?.handle?.retractAdjustment?.(
        "intentId" in key ? { intentId: key.intentId } : { adjustmentUuid: key.adjustmentUuid },
        reshapeEpoch,
      );
    }
    return { ok: true };
  }

  reshapeAdjustment(intent: ExpectationAdjustmentIntent): AdjustmentOpResult {
    if (!this.isClaimOwner()) return { ok: false, code: "not_claim_owner" };
    const adj = this.#findAdjustment({ intentId: intent.intentId });
    if (!adj) return { ok: false, code: "not_found" };
    if (!adj.applyReshape(intent.body, intent.reshapeEpoch)) {
      return { ok: false, code: "promote_refused" };
    }
    const E = this.#findExpectationByUuid(adj.targetUuid);
    const bind = E ? this.binding.get(E) : undefined;
    bind?.handle?.reshapeAdjustment?.(this.#adjustmentSnapshot(adj));
    return { ok: true };
  }

  /**
   * Apply simplex control acks from the resolver. Does not write Expectation (C2).
   */
  applyControlAck(ack: ResolverControlAck): AdjustmentOpResult {
    if (!this.isClaimOwner()) return { ok: false, code: "not_claim_owner" };
    const adj = this.#findAdjustment({ intentId: ack.intentId });
    if (!adj) return { ok: false, code: "not_found" };
    if (ack.reshapeEpoch !== adj.reshapeEpoch) {
      return { ok: false, code: "stale_epoch" };
    }
    switch (ack.type) {
      case "ackWillConsider":
        if (adj.consumption === "withdrawing" || isAdjustmentTerminal(adj.consumption)) {
          return { ok: false, code: "withdraw_refused" };
        }
        if (adj.consumption === "delivered") {
          adj.transitionConsumption("accepted");
        }
        return { ok: true };
      case "markConsidered":
        if (adj.consumption === "withdrawing" || adj.consumption === "withdrawn") {
          return { ok: false, code: "withdraw_refused" };
        }
        if (adj.consumption === "accepted" || adj.consumption === "delivered") {
          if (adj.consumption === "delivered") {
            adj.transitionConsumption("accepted");
          }
          adj.transitionConsumption("considered");
        }
        return { ok: true };
      case "ackDropped":
        // Machine-honest: only withdrawing → withdrawn (retract must markWithdrawing first).
        if (!adj.markWithdrawn()) {
          return { ok: false, code: "withdraw_refused" };
        }
        return { ok: true };
      default: {
        const _e: never = ack;
        void _e;
        return { ok: false, code: "not_found" };
      }
    }
  }

  /** Re-deliver or re-retract open adjustments for E after bind (rebind drain). */
  drainOpenAdjustments(E: Expectation): void {
    const bag = this.getAdjustmentBag();
    if (!bag) return;
    for (const adj of bag.adjustments) {
      if (adj.targetUuid !== E.uuid) continue;
      if (shouldRedeliverAdjustment(adj.consumption)) {
        // Re-deliver from queued/delivered/accepted without forcing re-queued
        const bind = this.binding.get(E);
        if (bind?.handle) {
          if (adj.consumption === "queued") {
            adj.transitionConsumption("delivered");
          }
          bind.handle.deliverAdjustment?.(this.#adjustmentSnapshot(adj));
        }
      } else if (shouldRetractOnRebind(adj.consumption)) {
        const bind = this.binding.get(E);
        bind?.handle?.retractAdjustment?.({ intentId: adj.intentId }, adj.reshapeEpoch);
      }
    }
  }

  #adjustmentSnapshot(adj: ExpectationAdjustment): AdjustmentSnapshot {
    return {
      intentId: adj.intentId,
      adjustmentUuid: adj.uuid,
      targetUuid: adj.targetUuid,
      reshapeEpoch: adj.reshapeEpoch,
      body: adj.body,
    };
  }

  /**
   * Resolve by intentId or adjustmentUuid.
   * For intentId: prefer **open** (non-terminal) row so recycled ids after
   * terminal do not shadow the live beacon (Fable H3).
   */
  #findAdjustment(key: { intentId: string } | { adjustmentUuid: string }): ExpectationAdjustment | undefined {
    const bag = this.getAdjustmentBag();
    if (!bag) return undefined;
    if ("adjustmentUuid" in key) {
      for (const adj of bag.adjustments) {
        if (adj.uuid === key.adjustmentUuid) return adj;
      }
      return undefined;
    }
    let terminalHit: ExpectationAdjustment | undefined;
    for (const adj of bag.adjustments) {
      if (adj.intentId !== key.intentId) continue;
      if (!isAdjustmentTerminal(adj.consumption)) return adj;
      terminalHit ??= adj;
    }
    return terminalHit;
  }

  #findExpectationByUuid(uuid: string): Expectation | undefined {
    for (const E of walkExpectationForest(this.getOpenWorkRoots())) {
      if (E.uuid === uuid) return E;
    }
    for (const E of this.walkCandidates()) {
      if (E.uuid === uuid) return E;
    }
    return undefined;
  }

  #refuseAdjustmentsForTarget(targetUuid: string): void {
    const bag = this.getAdjustmentBag();
    if (!bag) return;
    for (const adj of bag.adjustments) {
      if (adj.targetUuid !== targetUuid) continue;
      if (!isAdjustmentTerminal(adj.consumption)) {
        adj.markRefused();
      }
    }
  }

  #collectOwnedSubtree(root: Expectation): Expectation[] {
    const out: Expectation[] = [];
    const walk = (node: Expectation) => {
      out.push(node);
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(root);
    return out;
  }

  applyEmit(E: Expectation, message: ResolverEmit): void {
    if (E.state !== "running") return;
    if (message.epoch !== E.bindEpoch) return;

    switch (message.type) {
      case "progress":
        this.applyProgress(E, message.patch);
        return;
      case "complete":
        this.#settleTerminal(E, "sealed");
        return;
      case "fail":
        this.#settleTerminal(E, "failed");
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  #settleTerminal(E: Expectation, terminal: "sealed" | "failed"): void {
    const children = [...E.children];

    if (!E.trySettleFromRunning(terminal)) return;

    try {
      this.#refuseAdjustmentsForTarget(E.uuid);
    } catch {
      /* unmaterialized */
    }

    E.clearProgress();
    this.clearBind(E);
    this.publishAwarenessBinds();

    for (const child of children) {
      if (!isTerminal(child.state)) {
        this.cancelTree(child, "parent_terminal");
      }
    }
  }

  settleSurface(E: Expectation, body: SettleSurfaceBody): SettleSurfaceResult {
    if (!this.isClaimOwner()) {
      return { ok: false, code: "not_claim_owner" };
    }
    if (E.state !== "running") {
      return { ok: false, code: "not_running" };
    }

    const bind = this.binding.get(E);
    if (bind === undefined || bind.epoch !== E.bindEpoch || body.epoch !== E.bindEpoch) {
      return { ok: false, code: "stale_epoch" };
    }

    const terminal: "sealed" | "cancelled" = body.disposition === "abandon" ? "cancelled" : "sealed";

    const children = [...E.children];

    if (!E.trySettleFromRunning(terminal, body.epoch)) {
      // Race: cancelled/rebound under us, or epoch moved.
      return { ok: false, code: E.state === "running" ? "stale_epoch" : "not_running" };
    }

    try {
      this.#refuseAdjustmentsForTarget(E.uuid);
    } catch {
      /* unmaterialized */
    }

    if (bind.handle !== null && !bind.handle.aborted) {
      bind.handle.abort(body.disposition);
    }
    E.clearProgress();
    this.clearBind(E);
    this.publishAwarenessBinds();

    for (const child of children) {
      if (!isTerminal(child.state)) {
        this.cancelTree(child, "parent_terminal");
      }
    }

    return { ok: true };
  }

  markAwaitingRebind(E: Expectation, opts: MarkAwaitingRebindOpts): void {
    if (isTerminal(E.state)) return;

    const bind = this.binding.get(E);
    if (bind?.handle && !bind.handle.aborted) {
      bind.handle.abort(opts.reason ?? "awaiting_rebind");
    }

    if (E.state !== "awaiting_rebind" || opts.incrementRebind) {
      E.enterAwaitingRebind(opts.incrementRebind);
    }

    E.clearProgress();
    this.clearBind(E);
    this.clearActivating(E);
    this.publishAwarenessBinds();
  }

  onResolverDeath(E: Expectation, reason: unknown = "resolver_death"): void {
    if (E.state !== "running") return;
    this.markAwaitingRebind(E, { reason, incrementRebind: true });
  }

  disposeLease(reason: unknown = "lease_yield"): void {
    const bound = [...this.binding.entries()];

    for (const [, bind] of bound) {
      if (bind.handle && !bind.handle.aborted) {
        bind.handle.abort(reason);
      }
    }

    for (const [node] of bound) {
      if (node.state === "running") {
        node.transitionState("awaiting_rebind");
      }
      node.clearProgress();
    }

    for (const [node] of bound) {
      this.clearBind(node);
      this.clearActivating(node);
    }
    for (const node of this.activating) {
      this.clearActivating(node);
    }
    this.publishAwarenessBinds();
  }

  /** Repair orphans then activate units that need a claim. */
  reconcile(): void {
    const reachable = collectReachable(this.getOpenWorkRoots());

    for (const node of reachable) {
      if (isTreeOrphan(node)) {
        this.cancelTree(node, "parent_terminal");
      }
    }

    for (const node of this.walkCandidates()) {
      if (isTerminal(node.state)) continue;
      if (reachable.has(node)) continue;
      if (isForestOrphan(node, reachable)) {
        this.cancelTree(node, "orphaned");
      }
    }

    for (const node of collectReachable(this.getOpenWorkRoots())) {
      if (node.state === "running" && !this.binding.has(node) && !this.hasLiveClaimPeerBind(node)) {
        this.markAwaitingRebind(node, {
          reason: "claim_orphan",
          incrementRebind: false,
        });
      }
    }

    for (const node of collectReachable(this.getOpenWorkRoots())) {
      if (ACTIVATE_STATES.has(node.state)) {
        this.activate(node);
      }
    }
  }
}
