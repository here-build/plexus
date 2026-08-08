import type { Plexus, PlexusAwareness } from "@here.build/plexus";

import type { ExpectationLoader } from "./expectation-loader.js";
import type {
  ActorHandle,
  CancellationResult,
  CatalogPresenceStatus,
  ClaimPresenceStatus,
  LaunchContext,
  LoaderCapability,
  LoaderHealth,
  MailboxEntry,
  MailboxView,
  PlanResolution,
  PresencePort,
  SettleSurfaceResult,
  Settlement,
} from "./types.js";
import type {
  CancellationLaneEntry,
  CancellationStrength,
  EndCause,
  IntentRecord,
  SettleSurfaceDisposition,
} from "../shared/control.js";
import { isActivatable, isTerminal, type TerminalLifecycle } from "../shared/lifecycle.js";
import { Expectation } from "../shared/models/Expectation.js";
import { LaunchDefinition } from "../shared/models/LaunchDefinition.js";
import type { Orchestration } from "../shared/models/Orchestration.js";
import { SurfaceLaunchDefinition } from "../shared/models/SurfaceLaunchDefinition.js";
import { collectCancellationLane, collectIntentLane } from "../shared/pew-actor-catalog.js";
import { PEW } from "../shared/presence.js";

type AnyPlexus = Plexus<any>;

/**
 * Claim-owner process face. ONE RECORD, ONE WRITER after authorship ends.
 *
 * Two critical sections are synchronous by contract (no await):
 *   1. activation: resolve → running → spawn → processorClientId → table
 *   2. fold: terminal check → snapshot → durable writes → reap
 * That is what makes first-writer-wins true without locks.
 *
 * Singleton claim is product topology (singular pew-daemon), not dual-claim
 * awareness defence. Optional PEW via createPew carries actor reports +
 * per-expectation intent lanes + catalog pens — not a central intents bag.
 */
export abstract class Orchestrator {
  readonly table: Map<Expectation, TableEntry> = new Map();
  readonly activating: Set<Expectation> = new Set();

  readonly #loaderHealth = new Map<string, LoaderHealth>();
  readonly #capabilities = new Map<string, LoaderCapability>();
  /** In-flight load() promises — waiters (warm / rebootstrap) join these. */
  readonly #loadPromises = new Map<string, Promise<void>>();

  #pew: PEW | null | undefined = undefined;

  abstract getOrchestration(): Orchestration;

  /** Association by LaunchDefinition class, not string kind. */
  abstract getLoader(def: LaunchDefinition): ExpectationLoader | undefined;

  abstract isClaimOwner(): boolean;

  /** Work roots — must be transactional with entity homing or reconcile forest-orphans live work. */
  abstract getOpenWorkRoots(): readonly Expectation[];

  abstract walkCandidates(): Iterable<Expectation>;

  /** Null = process-local only (no presence wire). */
  abstract getSessionPlexus(): AnyPlexus | null;

  get pew(): PEW | null {
    if (this.#pew !== undefined) return this.#pew;
    this.#pew = this.createPew();
    return this.#pew;
  }

  protected createPew(): PEW | null {
    return null;
  }

  /**
   * Standing author intents across the session hub (lane scan). Prefer
   * per-target {@link collectIntentLane} / live mailboxes for product paths.
   */
  getAuthorIntents(): readonly IntentRecord[] {
    const pew = this.pew;
    const session = this.getSessionPlexus();
    if (pew && session) return pew.actors(session).intents;
    return [];
  }

  /** Host side-effect after catalog face is assembled (loaders + capabilities). PEW wire is separate. */
  protected onCatalogPresence(_status: CatalogPresenceStatus): void {}

  resolvePlan(kind: string): PlanResolution {
    const def = this.getOrchestration().plans.get(kind);
    if (def === undefined) return { status: "missing" };
    return this.getLoader(def) === undefined ? { status: "refused", def } : { status: "bound", def };
  }

  activate(E: Expectation): void {
    if (!this.isClaimOwner()) return;
    if (isTerminal(E.state)) return;
    if (E.state === "running") return;
    if (this.activating.has(E)) return;

    const outcome = this.resolvePlan(E.kind);
    if (outcome.status === "missing") {
      E.applyLifecycleEvent("PLAN_MISSING");
      return;
    }
    if (outcome.status === "refused") {
      E.applyLifecycleEvent("PLAN_REFUSED");
      return;
    }

    const def = outcome.def;
    const loader = this.getLoader(def);
    if (!loader) return;

    const kind = E.kind;
    if (this.#loaderHealth.get(kind) !== "loaded") {
      // Sticky failed health: work stays open (declared) until rebootstrap +
      // warm with a fixed plan — no hot loop, no silent env fallback.
      this.#ensureLoaded(kind, loader);
      return;
    }

    // no await below — activation critical section
    this.activating.add(E);
    try {
      E.transitionState("running"); // before spawn: legal edge + no double-execution on crash

      const controller = new AbortController();
      const presence = this.#mintPresencePort();
      // Live lane lens — no kernel mirror. Steers only; cancel is envelope.
      const mailbox = this.#liveMailbox(E, def.acceptsMessages);
      // Kernel is type-agnostic: generics re-establish at the loader/actor
      // edge, so the mailbox crosses as the base contract's `never` intents.
      const ctx: LaunchContext = {
        input: E.snapshotInput(),
        definition: def.toSnapshot(),
        signal: controller.signal,
        presence: presence.port,
        mailbox: mailbox as unknown as LaunchContext["mailbox"],
      };

      let handle: ActorHandle;
      try {
        handle = loader.spawn(ctx);
      } catch (error) {
        presence.destroy();
        this.fold(E, "failed", "crash", `spawn: ${String(error)}`);
        return;
      }

      // re-entrant fold during spawn: don't bind a handle to a dead entity
      if (isTerminal(E.state)) {
        controller.abort("activation_superseded");
        presence.destroy();
        return;
      }

      E.processorClientId = handle.clientId;
      this.table.set(E, { handle, controller, releasePresence: presence.destroy });
      handle.settled
        .then((s) =>
          s.outcome === "complete"
            ? this.fold(E, "sealed", "settled")
            : this.fold(E, "failed", "settled", String(s.reason)),
        )
        .catch((error: unknown) => this.fold(E, "failed", "crash", String(error)));
    } finally {
      this.activating.delete(E);
    }
    this.#publish();
  }

  #ensureLoaded(kind: string, loader: ExpectationLoader): void {
    const health = this.#loaderHealth.get(kind);
    // sticky until rebootstrap — no hot loop
    if (health === "loading" || health?.startsWith("failed:")) return;
    this.#loaderHealth.set(kind, "loading");
    this.#publish();
    const pending = this.#runLoad(kind, loader).finally(() => {
      if (this.#loadPromises.get(kind) === pending) this.#loadPromises.delete(kind);
    });
    this.#loadPromises.set(kind, pending);
    void pending;
  }

  async #runLoad(kind: string, loader: ExpectationLoader): Promise<void> {
    try {
      await loader.load();
      // Plan may have been replaced mid-load — do not mark a stale loader ready.
      const def = this.getOrchestration().plans.get(kind);
      if (def === undefined || this.getLoader(def) !== loader) return;
      this.#loaderHealth.set(kind, "loaded");
      this.#publish();
      this.reconcile();
      await this.#probe(kind, loader);
    } catch (error) {
      const def = this.getOrchestration().plans.get(kind);
      if (def === undefined || this.getLoader(def) !== loader) return;
      this.#loaderHealth.set(kind, `failed:${String(error)}`);
      this.#publish();
    }
  }

  /** Await all in-flight plan loads (post-warm / rebootstrap). */
  async waitForLoaders(): Promise<void> {
    const pending = [...this.#loadPromises.values()];
    if (pending.length === 0) return;
    await Promise.all(pending);
  }

  async #probe(kind: string, loader: ExpectationLoader): Promise<void> {
    if (loader.probeCapability === undefined) return;
    try {
      this.#capabilities.set(kind, await loader.probeCapability());
    } catch (error) {
      this.#capabilities.set(kind, { status: "unavailable", door: String(error) });
    }
    this.#publish();
  }

  async refreshCapability(kind?: string): Promise<void> {
    const kinds = kind === undefined ? [...this.#loaderHealth.keys()] : [kind];
    for (const k of kinds) {
      if (this.#loaderHealth.get(k) !== "loaded") continue;
      const def = this.getOrchestration().plans.get(k);
      const loader = def === undefined ? undefined : this.getLoader(def);
      if (loader) await this.#probe(k, loader);
    }
  }

  /**
   * Drop loader health + capability inventory so the next warm/activate
   * re-runs `load()` against the current plan defs.
   *
   * Clears **all** kinds (not only sticky failed): plan replacement (e.g.
   * openai-compat plan → new plan with different baseUrl/credential) must not leave
   * health=`loaded` for a previous def while `getLoader` returns a fresh
   * un-loaded instance ("load() first" spawn crash).
   */
  rebootstrap(): void {
    this.#loaderHealth.clear();
    this.#capabilities.clear();
    // In-flight loads will no-op their health write (stale-loader guard).
    this.#loadPromises.clear();
    this.reconcile();
  }

  /**
   * Host: warm every plan's loader so `probeCapability` can publish inventory
   * before the first activate (e.g. `/model` picker). Idempotent; sticky
   * failed health still requires {@link rebootstrap}.
   */
  warmPlans(): void {
    for (const [kind, def] of this.getOrchestration().plans) {
      const loader = this.getLoader(def);
      if (loader) this.#ensureLoaded(kind, loader);
    }
  }

  /**
   * Tree-scoped, first-writer-wins. Snapshot settlement/frames before abort —
   * abort-reaction traffic is cooperative-cancel territory, unread. Leaves first, root last.
   */
  fold(root: Expectation, terminal: TerminalLifecycle, cause: EndCause, detail?: string): void {
    if (isTerminal(root.state)) return;

    const nodes = collectSubtree(root);
    const frames = new Map<Expectation, string>();
    const settlements = new Map<Expectation, Settlement<unknown>>();
    for (const node of nodes) {
      const entry = this.table.get(node);
      if (!entry) continue;
      frames.set(node, serializeFrame(entry.handle.lastReport()));
      const s = entry.handle.settlement();
      if (s) settlements.set(node, s);
    }

    for (const node of nodes) {
      this.table.get(node)?.controller.abort(cause);
    }

    for (const node of nodes.slice(1).toReversed()) {
      this.#settleOrEnd(node, "cancelled", "supervision", "parent_terminal", frames, settlements);
    }
    this.#settleOrEnd(root, terminal, cause, detail ?? "", frames, settlements);

    for (const node of nodes) {
      this.#reap(node);
    }
    this.#publish();
  }

  #settleOrEnd(
    node: Expectation,
    terminal: TerminalLifecycle,
    cause: EndCause,
    detail: string,
    frames: ReadonlyMap<Expectation, string>,
    settlements: ReadonlyMap<Expectation, Settlement<unknown>>,
  ): void {
    if (isTerminal(node.state)) return;
    const frame = frames.get(node) ?? "null";
    const s = settlements.get(node);
    if (s !== undefined) {
      if (s.outcome === "complete") {
        node.applyTerminal("sealed", "settled", "", frame, { result: s.result });
      } else {
        node.applyTerminal("failed", "settled", String(s.reason), frame);
      }
      return;
    }
    node.applyTerminal(terminal, cause, detail, frame);
  }

  #reap(node: Expectation): void {
    const entry = this.table.get(node);
    if (entry) {
      entry.releasePresence();
      this.table.delete(node);
    }
    if (node.processorClientId !== 0) {
      node.processorClientId = 0;
    }
    this.activating.delete(node);
  }

  requestCancellation(
    target: Expectation,
    opts: { strength: CancellationStrength; reason?: string },
  ): CancellationResult {
    if (!this.isClaimOwner()) return { ok: false, code: "not_claim_owner" };
    if (isTerminal(target.state)) return { ok: false, code: "target_terminal" };
    if (opts.strength === "cooperative") return { ok: false, code: "cooperative_not_implemented" };
    this.fold(target, "cancelled", "cancel", opts.reason);
    return { ok: true };
  }

  settleSurface(E: Expectation, disposition: SettleSurfaceDisposition): SettleSurfaceResult {
    if (!this.isClaimOwner()) return { ok: false, code: "not_claim_owner" };
    const plan = this.resolvePlan(E.kind);
    if (plan.status === "missing" || !(plan.def instanceof SurfaceLaunchDefinition)) {
      return { ok: false, code: "not_surface" };
    }
    if (E.state !== "running") return { ok: false, code: "not_running" };
    this.fold(E, disposition === "abandon" ? "cancelled" : "sealed", "surface", disposition);
    return { ok: true };
  }

  /**
   * Admit envelope cancels from each open unit's **cancellation** lane
   * (`expectation:${uuid}:cancellation`). Steers are not mirrored — the
   * actor's mailbox is a live intents-lane lens. Cancellations are idempotent
   * because folding a terminal target is a no-op.
   */
  admitIntents(): void {
    const hub = this.#sessionHub();
    if (!hub) return;

    for (const target of collectReachable(this.getOpenWorkRoots())) {
      if (isTerminal(target.state)) continue;
      for (const entry of collectCancellationLane(hub, target.uuid)) {
        this.#admitCancellation(target, entry);
      }
    }
  }

  /**
   * Envelope verb — claim-owner at admission, never the actor's inbox.
   * Bypasses acceptsMessages and the running/bound gate: any open target is
   * cancellable (declared work folds too).
   */
  #admitCancellation(target: Expectation, entry: CancellationLaneEntry): void {
    if (isTerminal(target.state)) return;
    const body = (entry.body && typeof entry.body === "object" ? entry.body : {}) as {
      strength?: unknown;
      reason?: unknown;
    };
    this.requestCancellation(target, {
      strength: body.strength === "cooperative" ? "cooperative" : "immediate",
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
  }

  #sessionHub(): PlexusAwareness | null {
    return this.getSessionPlexus()?.awareness ?? null;
  }

  /**
   * Live mailbox: scan `expectation:${E.uuid}:intents` across peers.
   * Empty when terminal, unbound, or the plan rejects messages.
   * Cancellation is a separate lane — never mixed into the mailbox.
   */
  #liveMailbox(E: Expectation, acceptsMessages: boolean): MailboxView {
    const self = this;
    return {
      get entries(): readonly MailboxEntry[] {
        if (!acceptsMessages) return [];
        if (isTerminal(E.state)) return [];
        if (E.state !== "running" || !self.table.has(E)) return [];
        const hub = self.#sessionHub();
        if (!hub) return [];
        return collectIntentLane(hub, E.uuid).map((entry) => ({
          intentId: entry.intentId,
          body: entry.body,
        }));
      },
    };
  }

  reconcile(): void {
    if (!this.isClaimOwner()) return;

    const reachable = collectReachable(this.getOpenWorkRoots());

    for (const node of reachable) {
      if (isTreeOrphan(node)) {
        this.fold(node, "cancelled", "supervision", "parent_terminal");
      }
    }

    for (const node of this.walkCandidates()) {
      if (isTerminal(node.state)) continue;
      if (reachable.has(node)) continue;
      this.fold(node, "cancelled", "supervision", "orphaned");
    }

    // Single pew-daemon: no peer claim-bind shield. Running without a local
    // actor is always claim_orphan (process-local table is sole truth).
    for (const node of collectReachable(this.getOpenWorkRoots())) {
      if (node.state === "running" && !this.table.has(node) && !this.activating.has(node)) {
        this.fold(node, "failed", "supervision", "claim_orphan");
      }
    }

    for (const node of collectReachable(this.getOpenWorkRoots())) {
      if (isActivatable(node.state)) {
        this.activate(node);
      }
    }

    this.admitIntents();
  }

  /** Finished work seals (settlement preference); the rest cancels. */
  disposeLease(reason: string = "lease_yield"): void {
    for (const node of [...this.table.keys(), ...this.activating]) {
      if (isTerminal(node.state)) {
        this.#reap(node);
      } else {
        this.fold(node, "cancelled", "supervision", reason);
      }
    }
    this.#publish();
  }

  /**
   * Process-local held work — the claim table. Not published on awareness:
   * actors carry their own pens; singleton claim is the singular pew-daemon.
   */
  claimPresence(): ClaimPresenceStatus {
    return {
      binds: [...this.table.keys()],
    };
  }

  /** Process-local catalog face — what loaders.publish would write. */
  catalogPresence(): CatalogPresenceStatus {
    return {
      loaders: Object.fromEntries(this.#loaderHealth),
      capabilities: Object.fromEntries(this.#capabilities),
    };
  }

  #publish(): void {
    const catalog = this.catalogPresence();
    this.onCatalogPresence(catalog);

    const pew = this.pew;
    if (!pew) return;

    pew.loaders.publish(catalog);
  }

  #mintPresencePort(): { port: PresencePort; destroy: () => void } {
    let minted: { destroy(): void } | null = null;
    const port: PresencePort = {
      mintClient: () => {
        minted?.destroy();
        const pew = this.pew;
        const session = this.getSessionPlexus();
        if (pew && session) {
          const client = pew.actors(session).mintActorClient();
          minted = client;
          return client;
        }
        const inert = { clientID: 0, setReport: () => {}, destroy: () => {} };
        minted = inert;
        return inert;
      },
    };
    return { port, destroy: () => minted?.destroy() };
  }
}

export type TableEntry = {
  readonly handle: ActorHandle;
  readonly controller: AbortController;
  readonly releasePresence: () => void;
};

export function* walkExpectationForest(roots: readonly Expectation[]): Generator<Expectation> {
  const seen = new Set<Expectation>();
  const walk = function* (node: Expectation): Generator<Expectation> {
    if (seen.has(node)) return;
    seen.add(node);
    yield node;
    for (const child of node.children) {
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

function collectSubtree(root: Expectation): Expectation[] {
  const out: Expectation[] = [];
  const walk = (node: Expectation): void => {
    out.push(node);
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

function isTreeOrphan(node: Expectation): boolean {
  if (isTerminal(node.state)) return false;
  const parent = node.parent;
  if (parent === null || !(parent instanceof Expectation)) return false;
  return isTerminal(parent.state);
}

function serializeFrame(frame: unknown): string {
  try {
    return JSON.stringify(frame ?? null) ?? "null";
  } catch {
    return "null";
  }
}
