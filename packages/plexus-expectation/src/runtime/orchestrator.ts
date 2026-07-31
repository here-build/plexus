/**
 * Claim-owner runtime (plain class, not @syncing).
 *
 * `activating` / `binding` keyed by Expectation entity. Construct at lease
 * install; never in a model constructor. Product hosts subclass and implement
 * the abstract surface.
 */

import { Expectation } from "../app/expectation.js";
import type { SettleSurfaceDisposition } from "../app/intents.js";
import { isTerminal } from "../app/lifecycle.js";
import type { LaunchDefinition } from "../orchestration/launch-definition.js";
import type { Orchestration } from "../orchestration/orchestration.js";

import {
  LaunchDefinitionSnapshot,
  type ProgressPatch,
  type ResolverEmit,
  type ResolverHandle,
  type StartResolverFn,
} from "./resolver.js";

export type BindEntry = {
  handle: ResolverHandle | null;
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

export type SettleSurfaceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SettleSurfaceErrorCode };

const ACTIVATE_STATES: ReadonlySet<string> = new Set([
  "declared",
  "missing",
  "refused",
  "awaiting_rebind",
]);

export function* walkExpectationForest(
  roots: readonly Expectation[],
): Generator<Expectation> {
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
function isForestOrphan(
  E: Expectation,
  reachable: ReadonlySet<Expectation>,
): boolean {
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
  readonly maxRebinds: number;

  constructor(opts?: { maxRebinds?: number }) {
    this.maxRebinds = opts?.maxRebinds ?? DEFAULT_MAX_REBINDS;
  }

  // ── Abstract host surface ──────────────────────────────────────────────

  abstract getOrchestration(): Orchestration;

  /**
   * Whether this process hosts the launch mode (static floor — no hot-load of
   * loader types). Plan refuse when false.
   */
  abstract supportsLaunchMode(mode: string): boolean;

  /** kind preferred, then launchMode fallback. */
  abstract resolveModule(kind: string, launchMode: string): StartResolverFn | undefined;

  /**
   * Late-wire a known-kind or mode-level starter. Hosts without extensions
   * still implement (no-op is explicit). Call {@link reconcile} after register
   * so waiting open work can activate.
   */
  abstract registerModule(key: string, start: StartResolverFn): void;

  abstract isClaimOwner(): boolean;
  abstract getOpenWorkRoots(): readonly Expectation[];

  /**
   * Extra candidates for forest-orphan scan. Empty = openWork only.
   */
  abstract walkCandidates(): Iterable<Expectation>;

  abstract hasLiveClaimPeerBind(E: Expectation): boolean;
  abstract snapshotProductFields(E: Expectation): unknown;
  abstract applyProgress(E: Expectation, patch: ProgressPatch): void;
  abstract publishAwarenessBinds(): void;

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
    return Orchestrator.resolvePlan(kind, this.getOrchestration(), (mode) =>
      this.supportsLaunchMode(mode),
    );
  }

  /**
   * kind + plan actors + mode support → missing | refused | bound.
   */
  static resolvePlan(
    kind: string,
    orchestration: { readonly actors: { get(kind: string): LaunchDefinition | undefined } },
    supportsLaunchMode: (mode: string) => boolean,
  ): PlanResolution {
    const def = orchestration.actors.get(kind);
    if (def === undefined) {
      return { status: "missing" };
    }
    if (!supportsLaunchMode(def.launchMode)) {
      return { status: "refused", def };
    }
    return { status: "bound", def };
  }

  /** AbortController → ResolverHandle (signal fires on abort). */
  protected handleFromController(controller: AbortController): ResolverHandle {
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

      const startFn = this.resolveModule(E.kind, def.launchMode);
      if (!startFn) return;

      const epoch = E.beginRunning();
      if (E.state !== "running" || epoch === 0) return;

      const controller = new AbortController();
      const provisional = this.handleFromController(controller);
      this.setBind(E, { handle: provisional, epoch });
      this.publishAwarenessBinds();

      try {
        const handle = this.#startResolver(E, {
          startFn,
          epoch,
          def,
          controller,
          provisional,
        });
        const bind = this.binding.get(E);
        if (bind && bind.epoch === epoch && E.state === "running") {
          this.setBind(E, { handle: handle ?? provisional, epoch });
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
    this.clearBind(E);
    this.publishAwarenessBinds();
    if (!isTerminal(E.state)) {
      E.transitionState("failed");
    }
  }

  #startResolver(
    E: Expectation,
    {
      startFn,
      epoch,
      def,
      controller,
      provisional,
    }: {
      startFn: StartResolverFn;
      epoch: number;
      def: LaunchDefinition;
      controller: AbortController;
      provisional: ResolverHandle;
    },
  ): ResolverHandle {
    return (
      startFn(
        {
          kind: E.kind,
          epoch,
          definition: new LaunchDefinitionSnapshot({
            launchMode: def.launchMode,
            acceptsMessages: def.acceptsMessages,
            emitsProgress: def.emitsProgress,
            progressMode: def.progressMode,
          }),
          input: this.snapshotProductFields(E),
          signal: controller.signal,
        },
        (message: ResolverEmit) => {
          this.applyEmit(E, message);
        },
      ) ?? provisional
    );
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
      this.clearBind(node);
      this.clearActivating(node);
    }
    this.publishAwarenessBinds();
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
    if (!bind || bind.epoch !== E.bindEpoch || body.epoch !== E.bindEpoch) {
      return { ok: false, code: "stale_epoch" };
    }

    const terminal: "sealed" | "cancelled" =
      body.disposition === "abandon" ? "cancelled" : "sealed";

    const children = [...E.children];

    if (!E.trySettleFromRunning(terminal, body.epoch)) {
      if (E.state !== "running") {
        return { ok: false, code: "not_running" };
      }
      return { ok: false, code: "stale_epoch" };
    }

    if (bind.handle && !bind.handle.aborted) {
      bind.handle.abort(body.disposition);
    }
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
    }

    for (const [node] of bound) {
      this.clearBind(node);
      this.clearActivating(node);
    }
    for (const node of [...this.activating]) {
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
      if (
        node.state === "running" &&
        !this.binding.has(node) &&
        !this.hasLiveClaimPeerBind(node)
      ) {
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
