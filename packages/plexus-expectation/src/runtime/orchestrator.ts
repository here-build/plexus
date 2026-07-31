/**
 * Orchestrator — process-local claim-owner host (plain class, not @syncing).
 *
 * Entity keys for `activating` / `binding` — never uuid claim indexes (law 16).
 * Construct explicitly at lease install (PR-6); never in a model constructor.
 */

import type { Expectation } from "../app/expectation.js";
import type { Orchestration } from "../orchestration/orchestration.js";

import { activate } from "./activate.js";
import { cancelTree } from "./cancel-tree.js";
import { applyEmit, type ProgressApplier } from "./emit.js";
import {
  DEFAULT_MAX_REBINDS,
  disposeLease,
  markAwaitingRebind,
  onResolverDeath,
  type MarkAwaitingRebindOpts,
} from "./liveness.js";
import type { ModuleRegistry } from "./modules.js";
import { modulesFromMap } from "./modules.js";
import { reconcile, type ReconcileWalk } from "./reconcile.js";
import type {
  ProgressPatch,
  ResolverEmit,
  ResolverHandle,
  StartResolverFn,
} from "./resolver.js";
import {
  settleSurface,
  type SettleSurfaceBody,
  type SettleSurfaceResult,
} from "./surface-settle.js";

/** Process-local bind entry for a claimed Expectation. */
export type BindEntry = {
  handle: ResolverHandle | null;
  epoch: number;
};

export type LoadedModulesSource = ReadonlySet<string> | (() => ReadonlySet<string>);

/**
 * Session-like host dependencies injected at construct time.
 * Claim owner (daemon) supplies these; PEW does not own product roots.
 */
export type OrchestratorHost = {
  /** Session Orchestration plan registry. */
  getOrchestration: () => Orchestration;
  /** Modes the host has loaded (e.g. `"inprocess"`, `"surface"`). */
  loadedModules: LoadedModulesSource;
  /** kind and/or launchMode → startResolver body. */
  modules: ModuleRegistry | ReadonlyMap<string, StartResolverFn>;
  /** Product field snapshot for resolver input (default: `{}`). */
  snapshotProductFields?: (E: Expectation) => unknown;
  /** Optional progress patch applier (product fields). */
  applyProgress?: ProgressApplier;
  /** Awareness `pew.binds` publish — optional / no-op for unit tests. */
  publishAwarenessBinds?: () => void;
  /**
   * Claim-owner gate for settleSurface (§5.4). Default `true`.
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
   * Live claim-owner peer bind probe (PR-9). Default: no peer.
   * @see ReconcileWalk.hasLiveClaimPeerBind
   */
  hasLiveClaimPeerBind?: (E: Expectation) => boolean;
};

/**
 * Claim-owner runtime. Process-local maps only; durable writes go through
 * Expectation.transitionState inside the entity's plexus.transact when present.
 */
export class Orchestrator {
  /** Single-flight activation set — entity keys. */
  readonly activating: Set<Expectation> = new Set();

  /** Live binds — entity keys, not uuid strings. */
  readonly binding: Map<Expectation, BindEntry> = new Map();

  readonly maxRebinds: number;

  private readonly host: {
    getOrchestration: () => Orchestration;
    loadedModules: LoadedModulesSource;
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
    const modules: ModuleRegistry =
      typeof (host.modules as ModuleRegistry).resolve === "function"
        ? (host.modules as ModuleRegistry)
        : modulesFromMap(host.modules as ReadonlyMap<string, StartResolverFn>);

    const isClaimOwnerOpt = host.isClaimOwner;
    this.maxRebinds = host.maxRebinds ?? DEFAULT_MAX_REBINDS;

    this.host = {
      getOrchestration: host.getOrchestration,
      loadedModules: host.loadedModules,
      modules,
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

  // ── Host accessors (used by activate / emit / cancel helpers) ──────────

  getOrchestration(): Orchestration {
    return this.host.getOrchestration();
  }

  getLoadedModules(): ReadonlySet<string> {
    const src = this.host.loadedModules;
    return typeof src === "function" ? src() : src;
  }

  resolveModule(kind: string, launchMode: string): StartResolverFn | undefined {
    return this.host.modules.resolve(kind, launchMode);
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

  // ── Public claim-owner API ─────────────────────────────────────────────

  /** §5.3 activation. */
  activate(E: Expectation): void {
    activate(this, E);
  }

  /**
   * §3.5 cancelTree — abort-before-durable.
   * Mandatory: AbortSignal fires before state becomes `cancelled`.
   */
  cancelTree(root: Expectation, reason?: unknown): void {
    cancelTree(this, root, reason);
  }

  /** §3.3 emit apply (inprocess sync path; out-of-proc host channels use this too). */
  applyEmit(E: Expectation, message: ResolverEmit): void {
    applyEmit(this, E, message);
  }

  /** §5.4 surface settle (allow|deny|abandon). Structured result, no throw. */
  settleSurface(E: Expectation, body: SettleSurfaceBody): SettleSurfaceResult {
    return settleSurface(this, E, body);
  }

  /**
   * §5.6 unexpected resolver death → awaiting_rebind + rebindCount++.
   */
  onResolverDeath(E: Expectation, reason?: unknown): void {
    onResolverDeath(this, E, reason);
  }

  /**
   * §5.6–5.7 mark unit awaiting rebind (abort-first).
   * `incrementRebind: true` only for unexpected resolver loss.
   */
  markAwaitingRebind(E: Expectation, opts: MarkAwaitingRebindOpts): void {
    markAwaitingRebind(this, E, opts);
  }

  /**
   * §5.6 lease yield: abort all binds then awaiting_rebind without burning
   * rebindCount (T20).
   */
  disposeLease(reason?: unknown): void {
    disposeLease(this, reason);
  }

  /**
   * §5.9 reconcile: tree/forest orphan cancel, claim-orphan rebind, activate sweep.
   * Uses host `getOpenWorkRoots` when `walk` is omitted.
   */
  reconcile(walk?: ReconcileWalk): void {
    reconcile(this, walk);
  }
}
