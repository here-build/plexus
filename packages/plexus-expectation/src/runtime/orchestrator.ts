/**
 * Orchestrator — process-local claim-owner host (plain class, not @syncing).
 *
 * Entity keys for `activating` / `binding` — never uuid claim indexes (law 16).
 * Construct explicitly at lease install; never in a model constructor.
 *
 * Methods live on the class (not free functions taking orch as first arg).
 */

import { Expectation } from "../app/expectation.js";
import type { SettleSurfaceDisposition } from "../app/intents.js";
import { isOpen, isTerminal } from "../app/lifecycle.js";
import type { Orchestration } from "../orchestration/orchestration.js";
import { resolvePlan } from "../orchestration/plan-resolution.js";

import type { ModuleRegistry } from "./modules.js";
import {
  handleFromController,
  type ProgressPatch,
  type ResolverEmit,
  type ResolverHandle,
  snapshotDefinition,
  type StartResolverFn,
} from "./resolver.js";

// ── Public types ───────────────────────────────────────────────────────────

/** Process-local bind entry for a claimed Expectation. */
export type BindEntry = {
  handle: ResolverHandle | null;
  epoch: number;
};

/** Host progress hook type (product-owned fields). */
export type ProgressApplier = (E: Expectation, patch: ProgressPatch) => void;

/** Default cap on unexpected rebinds before activation fails with rebind_exhausted. */
export const DEFAULT_MAX_REBINDS = 3;

export type MarkAwaitingRebindOpts = {
  readonly reason?: unknown;
  /** True for unexpected resolver death; false for lease_yield / claim-orphan class. */
  readonly incrementRebind: boolean;
};

/** Body of a surface settle (from SettleSurfaceIntent after E resolve). */
export type SettleSurfaceBody = {
  /** Caller's observed `bindEpoch` — must match durable + local bind. */
  readonly epoch: number;
  readonly disposition: SettleSurfaceDisposition;
};

export type SettleSurfaceErrorCode = "not_claim_owner" | "not_running" | "stale_epoch";

export type SettleSurfaceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SettleSurfaceErrorCode };

/** Host surface for forest walks — product owns openWork placement. */
export type ReconcileWalk = {
  /**
   * Roots of the open-work forest (product-owned placement).
   * Used for reachability + activation sweep.
   */
  getOpenWorkRoots: () => readonly Expectation[];
  /**
   * Optional broader candidate set for forest-orphan scan (e.g. product maps,
   * known detached units). Defaults to openWork roots + their subtrees only
   * (tree orphans still repaired; forest orphans need candidates outside).
   */
  walkCandidates?: () => Iterable<Expectation>;
  /**
   * True if a live claim-owner peer still advertises a pew.binds entry for E.
   * Default: always false → claim orphans rebind locally.
   */
  hasLiveClaimPeerBind?: (E: Expectation) => boolean;
};

/**
 * Session-like host dependencies injected at construct time.
 * Claim owner (daemon) supplies these; PEW does not own product roots.
 */
export type OrchestratorHost = {
  /** Session Orchestration plan registry. */
  getOrchestration: () => Orchestration;
  /**
   * Loader types this process hosts (`"inprocess"`, `"surface"`, …).
   * Static for the claim-owner life — new loader types cannot hot-load.
   */
  loadedModules: ReadonlySet<string>;
  /**
   * Resolver handlers: `resolve(kind, launchMode)` + late `register`.
   * Use {@link modulesFromRecord} / {@link modulesFromMap} to adapt plain maps.
   * Extensions register known-kind starters; then {@link Orchestrator.noteModulesChanged}.
   */
  modules: ModuleRegistry;
  /** Product field snapshot for resolver input (default: `{}`). */
  snapshotProductFields?: (E: Expectation) => unknown;
  /** Optional progress patch applier (product fields). */
  applyProgress?: ProgressApplier;
  /** Awareness `pew.binds` publish — optional; default no-op. */
  publishAwarenessBinds?: () => void;
  /**
   * Claim-owner gate for activate / settleSurface (§5.4). Default `true`.
   * Host may pass a live getter when lease ownership flips.
   */
  isClaimOwner?: boolean | (() => boolean);
  /** Cap unexpected rebinds before `failed` (default {@link DEFAULT_MAX_REBINDS}). */
  maxRebinds?: number;
  /**
   * Open-work forest roots for reconcile (§5.9). Required for
   * `orchestrator.reconcile()` without an explicit walk argument.
   */
  getOpenWorkRoots?: () => readonly Expectation[];
  /**
   * Broader candidate walk for forest-orphan repair (optional).
   * @see ReconcileWalk.walkCandidates
   */
  walkCandidates?: () => Iterable<Expectation>;
  /**
   * Live claim-owner peer bind probe. Default: no peer.
   * @see ReconcileWalk.hasLiveClaimPeerBind
   */
  hasLiveClaimPeerBind?: (E: Expectation) => boolean;
};

const ACTIVATE_STATES: ReadonlySet<string> = new Set([
  "declared",
  "missing",
  "refused",
  "awaiting_rebind",
]);

// ── Forest helpers (pure; used by reconcile + product hosts) ───────────────

/** Pre-order walk of owned Expectation subtrees. */
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

/** Collect reachable set from openWork roots. */
export function collectReachable(roots: readonly Expectation[]): Set<Expectation> {
  return new Set(walkExpectationForest(roots));
}

/**
 * True when E is a tree orphan: non-terminal under a terminal Expectation parent.
 */
export function isTreeOrphan(E: Expectation): boolean {
  if (isTerminal(E.state)) return false;
  const parent = E.parent;
  if (parent == null) return false;
  if (!(parent instanceof Expectation)) return false;
  return isTerminal(parent.state);
}

/**
 * True when E is a forest orphan relative to openWork reachability.
 * Prefer Plexus `isDetached` when materialized; also treat as orphan if not
 * reachable from openWork roots.
 */
export function isForestOrphan(
  E: Expectation,
  reachable: ReadonlySet<Expectation>,
): boolean {
  if (isTerminal(E.state)) return false;
  if (reachable.has(E)) return false;
  try {
    if (E.isDetached) return true;
  } catch {
    // unmaterialized / no doc — fall through
  }
  return true;
}

/**
 * Claim-owner runtime. Process-local maps only; durable writes go through
 * Expectation `@syncing.action` methods.
 */
export class Orchestrator {
  /** Single-flight activation set — entity keys. */
  readonly activating: Set<Expectation> = new Set();

  /** Live binds — entity keys, not uuid strings. */
  readonly binding: Map<Expectation, BindEntry> = new Map();

  readonly maxRebinds: number;

  private readonly host: {
    getOrchestration: () => Orchestration;
    loadedModules: ReadonlySet<string>;
    modules: ModuleRegistry;
    snapshotProductFields: (E: Expectation) => unknown;
    applyProgress: ProgressApplier;
    publishAwarenessBinds: () => void;
    isClaimOwner: () => boolean;
    getOpenWorkRoots?: () => readonly Expectation[];
    walkCandidates?: () => Iterable<Expectation>;
    hasLiveClaimPeerBind?: (E: Expectation) => boolean;
  };

  constructor(host: OrchestratorHost) {
    const isClaimOwnerOpt = host.isClaimOwner;
    this.maxRebinds = host.maxRebinds ?? DEFAULT_MAX_REBINDS;

    this.host = {
      getOrchestration: host.getOrchestration,
      loadedModules: host.loadedModules,
      modules: host.modules,
      snapshotProductFields: host.snapshotProductFields ?? (() => ({})),
      applyProgress: host.applyProgress ?? (() => {}),
      publishAwarenessBinds: host.publishAwarenessBinds ?? (() => {}),
      isClaimOwner:
        typeof isClaimOwnerOpt === "function"
          ? isClaimOwnerOpt
          : () => isClaimOwnerOpt ?? true,
      getOpenWorkRoots: host.getOpenWorkRoots,
      walkCandidates: host.walkCandidates,
      hasLiveClaimPeerBind: host.hasLiveClaimPeerBind,
    };
  }

  // ── Host accessors ─────────────────────────────────────────────────────

  getOrchestration(): Orchestration {
    return this.host.getOrchestration();
  }

  /** Static loader-type floor for this claim-owner process. */
  getLoadedModules(): ReadonlySet<string> {
    return this.host.loadedModules;
  }

  resolveModule(kind: string, launchMode: string): StartResolverFn | undefined {
    return this.host.modules.resolve(kind, launchMode);
  }

  /**
   * Late-wire a known-kind (or mode-level) starter on the host registry.
   * Call {@link noteModulesChanged} after register so open work can activate.
   */
  registerModule(key: string, start: StartResolverFn): void {
    this.host.modules.register(key, start);
  }

  /**
   * Handler table changed (extension attach). Re-runs reconcile so units that
   * were waiting for a starter can enter `running`. Loader types do not change.
   */
  noteModulesChanged(): void {
    if (!this.getReconcileWalk()) return;
    this.reconcile();
  }

  snapshotProductFields(E: Expectation): unknown {
    return this.host.snapshotProductFields(E);
  }

  applyProgress(E: Expectation, patch: ProgressPatch): void {
    this.host.applyProgress(E, patch);
  }

  publishAwarenessBinds(): void {
    this.host.publishAwarenessBinds();
  }

  isClaimOwner(): boolean {
    return this.host.isClaimOwner();
  }

  /** Reconcile walk from host options, if configured. */
  getReconcileWalk(): ReconcileWalk | undefined {
    if (!this.host.getOpenWorkRoots) return undefined;
    return {
      getOpenWorkRoots: this.host.getOpenWorkRoots,
      walkCandidates: this.host.walkCandidates,
      hasLiveClaimPeerBind: this.host.hasLiveClaimPeerBind,
    };
  }

  // ── Process-local map mutators ─────────────────────────────────────────

  setBind(E: Expectation, entry: BindEntry): void {
    this.binding.set(E, entry);
  }

  clearBind(E: Expectation): void {
    this.binding.delete(E);
  }

  clearActivating(E: Expectation): void {
    this.activating.delete(E);
  }

  // ── §5.3 activate ──────────────────────────────────────────────────────

  /**
   * Activate a single Expectation. Single-flight via `activating` set.
   * Idempotent for healthy running binds.
   *
   * Non-surface: never takes durable `running` without a resolved starter
   * (extensions may {@link registerModule} later → {@link noteModulesChanged}).
   */
  activate(E: Expectation): void {
    if (isTerminal(E.state)) return;
    // Lease / dual-claim gate (§2.2)
    if (!this.isClaimOwner()) return;
    if (this.activating.has(E)) return;

    const existing = this.binding.get(E);
    if (E.state === "running" && existing) {
      if (this.#isHealthy(existing)) return;
      // Unhealthy bind: count as resolver death — do not silent-restart.
      this.onResolverDeath(E, "unhealthy_bind");
      return;
    }

    // §5.7 — unexpected rebind budget exhausted
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
      const outcome = resolvePlan(E.kind, this.getOrchestration(), this.getLoadedModules());

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

      // Surface: mode floor only — no startResolver body (human settle API).
      if (def.launchMode === "surface") {
        const epoch = E.beginRunning();
        if (E.state !== "running" || epoch === 0) return;
        const controller = new AbortController();
        const surfaceWait = handleFromController(controller);
        this.setBind(E, { handle: surfaceWait, epoch });
        this.publishAwarenessBinds();
        return;
      }

      // Inprocess (and other paid modes): require starter BEFORE durable running.
      // Missing handler = wait for extension register + noteModulesChanged — not fail.
      const startFn = this.resolveModule(E.kind, def.launchMode);
      if (!startFn) return;

      const epoch = E.beginRunning();
      if (E.state !== "running" || epoch === 0) return;

      // Placeholder bind so cancel during start can still abort.
      const controller = new AbortController();
      const provisional = handleFromController(controller);
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
    { startFn, epoch, def, controller, provisional }: {
      startFn: StartResolverFn;
      epoch: number;
      def: Parameters<typeof snapshotDefinition>[0];
      controller: AbortController;
      provisional: ResolverHandle;
    },
  ): ResolverHandle {
    // Local loop: entity stays the key (emit closes over E). No .uuid here —
    // wire identity is resolved only at sync edges (awareness / journal).
    return startFn({
      work: { kind: E.kind },
      epoch,
      definition: snapshotDefinition(def),
      input: this.snapshotProductFields(E),
      signal: controller.signal,
    }, (message: ResolverEmit) => {
      this.applyEmit(E, message);
    }) ?? provisional;
  }

  #isHealthy(bind: BindEntry): boolean {
    if (bind.handle == null) return true;
    return !bind.handle.aborted;
  }

  #isRebindExhausted(E: Expectation): boolean {
    return E.state === "awaiting_rebind" && E.rebindCount > this.maxRebinds;
  }

  // ── §3.5 cancel ────────────────────────────────────────────────────────

  /**
   * Cancel subtree — abort-before-durable (money-critical).
   *
   * Claim-owner only: aborts live resolver handles, then writes durable
   * `cancelled` on the owned subtree (children before parent), then clears
   * process-local binds. Not an Expectation field write.
   */
  cancelTree(root: Expectation, reason?: unknown): void {
    const nodes = this.#collectOwnedSubtree(root);

    // ── ABORT PHASE — stop spend before durable settle ───────────────────
    for (const node of nodes) {
      const bind = this.binding.get(node);
      if (bind && node.state === "running" && bind.handle && !bind.handle.aborted) {
        bind.handle.abort(reason);
      }
    }

    // ── DURABLE PHASE — one @syncing.action region on root ───────────────
    root.cancelSubtreeDurable();

    // ── Clear process-local maps ─────────────────────────────────────────
    for (const node of nodes) {
      this.clearBind(node);
      this.clearActivating(node);
    }
    this.publishAwarenessBinds();
  }

  /** Root + owned descendants (pre-order). */
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

  // ── §3.3 emit ──────────────────────────────────────────────────────────

  /**
   * Apply a resolver emit against claim-owner state.
   *
   * Dropped when `E.state !== "running"` or epoch mismatch.
   * Complete → sealed; fail → failed. Parent terminal cascades cancelTree.
   */
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

  // ── §5.4 surface settle ────────────────────────────────────────────────

  /**
   * Settle a surface-mode Expectation (approve / deny / abandon).
   * Structured errors only (no throw).
   */
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

  // ── §5.6–5.7 liveness / rebind ─────────────────────────────────────────

  /**
   * Abort live handle (if any), write `awaiting_rebind`, clear process-local bind.
   * Money rule: abort before durable state change.
   */
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

  /**
   * Unexpected resolver death while claim owner is alive (§5.6).
   * Increments rebindCount; leaves E ready for re-activate via activate/reconcile.
   */
  onResolverDeath(E: Expectation, reason: unknown = "resolver_death"): void {
    if (E.state !== "running") return;
    this.markAwaitingRebind(E, { reason, incrementRebind: true });
  }

  /**
   * Lease dispose / yield (§5.6).
   * Abort all binds then `awaiting_rebind` with **rebindCount unchanged**.
   */
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

  // ── §5.9 reconcile ─────────────────────────────────────────────────────

  /**
   * Repair orphans then activate units that need a claim.
   * Uses host `getOpenWorkRoots` when `walk` is omitted.
   */
  reconcile(walk?: ReconcileWalk): void {
    const host = walk ?? this.getReconcileWalk();
    if (!host) {
      throw new Error(
        "reconcile requires getOpenWorkRoots (pass ReconcileWalk or set host.getOpenWorkRoots)",
      );
    }

    const reachable = collectReachable(host.getOpenWorkRoots());
    const hasLivePeer = host.hasLiveClaimPeerBind ?? (() => false);

    // 1) Tree orphans under openWork
    for (const node of reachable) {
      if (isTreeOrphan(node)) {
        this.cancelTree(node, "parent_terminal");
      }
    }

    // 1b) Forest orphans
    for (const node of host.walkCandidates?.() ?? reachable) {
      if (isTerminal(node.state)) continue;
      if (reachable.has(node)) continue;
      if (isForestOrphan(node, reachable)) {
        this.cancelTree(node, "orphaned");
      }
    }

    // 2) Claim orphans: running, no local bind, no live peer
    for (const node of collectReachable(host.getOpenWorkRoots())) {
      if (node.state === "running" && !this.binding.has(node) && !hasLivePeer(node)) {
        this.markAwaitingRebind(node, {
          reason: "claim_orphan",
          incrementRebind: false,
        });
      }
    }

    // 3) Activation sweep
    for (const node of collectReachable(host.getOpenWorkRoots())) {
      if (isOpen(node.state) && ACTIVATE_STATES.has(node.state)) {
        this.activate(node);
      }
    }
  }
}
