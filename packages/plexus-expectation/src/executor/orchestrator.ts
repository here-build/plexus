import type { Plexus } from "@here.build/plexus";
import { observable } from "mobx";

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
  PlanResolution,
  PresencePort,
  SettleSurfaceResult,
  Settlement,
} from "./types.js";
import type {
  CancellationStrength,
  EndCause,
  IntentAckState,
  IntentRecord,
  SettleSurfaceDisposition,
} from "../shared/control.js";
import { isActivatable, isTerminal, type TerminalLifecycle } from "../shared/lifecycle.js";
import { Expectation } from "../shared/models/Expectation.js";
import { LaunchDefinition } from "../shared/models/LaunchDefinition.js";
import type { Orchestration } from "../shared/models/Orchestration.js";
import { SurfaceLaunchDefinition } from "../shared/models/SurfaceLaunchDefinition.js";
import { PEW } from "../shared/presence.js";

type AnyPlexus = Plexus<any>;

/**
 * Claim-owner process face. ONE RECORD, ONE WRITER after authorship ends.
 *
 * Two critical sections are synchronous by contract (no await):
 *   1. activation: resolve → running → spawn → processorClientId → table
 *   2. fold: terminal check → snapshot → durable writes → reap
 * That is what makes first-writer-wins true without locks. Lease is mutual
 * exclusion; dual-claim presence is advisory. Optional PEW via createPew.
 */
export abstract class Orchestrator {
  readonly table: Map<Expectation, TableEntry> = new Map();
  readonly activating: Set<Expectation> = new Set();

  readonly #loaderHealth = new Map<string, LoaderHealth>();
  readonly #capabilities = new Map<string, LoaderCapability>();
  /** In-flight load() promises — waiters (warm / rebootstrap) join these. */
  readonly #loadPromises = new Map<string, Promise<void>>();
  readonly #mailboxes = new Map<Expectation, MailboxEntry[]>();
  readonly #acks = new Map<string, { state: IntentAckState; target: Expectation | null }>();

  #pew: PEW | null | undefined = undefined;
  #claimInstalled = false;

  abstract getOrchestration(): Orchestration;

  /** Association by LaunchDefinition class, not string kind. */
  abstract getLoader(def: LaunchDefinition): ExpectationLoader | undefined;

  abstract isClaimOwner(): boolean;

  /** Work roots — must be transactional with entity homing or reconcile forest-orphans live work. */
  abstract getOpenWorkRoots(): readonly Expectation[];

  abstract walkCandidates(): Iterable<Expectation>;

  abstract hasLiveClaimPeerBind(E: Expectation): boolean;

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

  getAuthorIntents(): readonly IntentRecord[] {
    const pew = this.pew;
    const session = this.getSessionPlexus();
    if (pew && session) return pew.actors(session).intents;
    return [];
  }

  /** Host side-effect after claim face is assembled (binds + acks). PEW wire is separate. */
  protected onClaimPresence(_status: ClaimPresenceStatus): void {}

  /** Host side-effect after catalog face is assembled (loaders + capabilities). PEW wire is separate. */
  protected onCatalogPresence(_status: CatalogPresenceStatus): void {}

  resolvePlan(kind: string): PlanResolution {
    const def = this.getOrchestration().plans.get(kind);
    if (def === undefined) return { status: "missing" };
    return this.getLoader(def) === undefined ? { status: "refused", def } : { status: "bound", def };
  }

  activate(E: Expectation): void {
    if (!this.isClaimOwner()) return;
    if (this.#isDualClaimFrozen()) return;
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
      const mailbox = this.#ensureMailbox(E);
      // Kernel is type-agnostic: generics re-establish at the loader/actor
      // edge, so the mailbox crosses as the base contract's `never` intents.
      const ctx: LaunchContext = {
        input: E.snapshotInput(),
        definition: def.toSnapshot(),
        signal: controller.signal,
        presence: presence.port,
        mailbox: { entries: mailbox } as unknown as LaunchContext["mailbox"],
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
      handle.onControlOutcome((o) => this.#applyIntentOutcome(o.intentId, o.outcome));
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
   * LocalAcp → new LocalAcp with different baseUrl/credential) must not leave
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
    const mailbox = this.#mailboxes.get(node);
    if (mailbox) {
      for (const item of mailbox) this.#acks.delete(item.intentId);
      this.#mailboxes.delete(node);
    }
    for (const [intentId, ack] of this.#acks) {
      if (ack.target === node) this.#acks.delete(intentId);
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

  admitIntents(): void {
    const intents = this.getAuthorIntents();
    const liveIds = new Set(intents.map((i) => i.intentId));

    for (const [intentId, ack] of this.#acks) {
      if (liveIds.has(intentId)) continue;
      this.#removeMailboxEntry(ack.target, intentId);
      this.#acks.delete(intentId);
    }

    for (const intent of intents) {
      if (intent.kind === "cancel") {
        this.#admitCancellation(intent);
        continue;
      }

      const existing = this.#acks.get(intent.intentId);
      if (existing !== undefined) {
        // refused is not final while the intent stays authored (mid-load → bind)
        if (existing.state.startsWith("refused:")) {
          this.#acks.delete(intent.intentId);
        } else {
          const retargetedDuplicate = existing.target !== null && existing.target !== intent.target;
          if (!retargetedDuplicate) {
            this.#reshapeMailboxEntry(existing.target, intent);
          }
          continue;
        }
      }

      const target = intent.target;
      if (isTerminal(target.state)) {
        this.#acks.set(intent.intentId, { state: "refused:target_terminal", target: null });
        continue;
      }
      const entry = this.table.get(target);
      if (entry === undefined || target.state !== "running") {
        this.#acks.set(intent.intentId, { state: "refused:target_unbound", target: null });
        continue;
      }
      const plan = this.resolvePlan(target.kind);
      if (plan.status === "missing" || !plan.def.acceptsMessages) {
        this.#acks.set(intent.intentId, { state: "refused:messages_not_accepted", target: null });
        continue;
      }
      this.#acks.set(intent.intentId, { state: "admitted", target });
      this.#ensureMailbox(target).push({ intentId: intent.intentId, body: intent.body });
    }
    this.#publish();
  }

  /**
   * Envelope verb — kernel-handled at admission, never the actor's mailbox.
   * Bypasses acceptsMessages and the running/bound gate: any open target is
   * cancellable (declared work folds too). One execution per intentId.
   */
  #admitCancellation(intent: IntentRecord): void {
    const existing = this.#acks.get(intent.intentId);
    if (existing !== undefined) {
      if (!existing.state.startsWith("refused:")) return;
      this.#acks.delete(intent.intentId);
    }
    const target = intent.target;
    if (isTerminal(target.state)) {
      this.#acks.set(intent.intentId, { state: "refused:target_terminal", target: null });
      return;
    }
    const body = (intent.body && typeof intent.body === "object" ? intent.body : {}) as {
      strength?: unknown;
      reason?: unknown;
    };
    const result = this.requestCancellation(target, {
      strength: body.strength === "cooperative" ? "cooperative" : "immediate",
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    this.#acks.set(intent.intentId, result.ok ? { state: "considered", target } : { state: "dropped", target: null });
  }

  #applyIntentOutcome(intentId: string, outcome: "considered" | "dropped"): void {
    const ack = this.#acks.get(intentId);
    if (ack?.state !== "admitted") return;
    this.#acks.set(intentId, { state: outcome, target: ack.target });
    this.#removeMailboxEntry(ack.target, intentId);
    this.#publish();
  }

  #ensureMailbox(E: Expectation): MailboxEntry[] {
    let box = this.#mailboxes.get(E);
    if (!box) {
      box = observable.array<MailboxEntry>([], { deep: false });
      this.#mailboxes.set(E, box);
    }
    return box;
  }

  #removeMailboxEntry(target: Expectation | null, intentId: string): void {
    if (target === null) return;
    const box = this.#mailboxes.get(target);
    if (!box) return;
    const index = box.findIndex((item) => item.intentId === intentId);
    if (index !== -1) box.splice(index, 1);
  }

  #reshapeMailboxEntry(target: Expectation | null, intent: IntentRecord): void {
    if (target === null) return;
    const box = this.#mailboxes.get(target);
    if (!box) return;
    const index = box.findIndex((item) => item.intentId === intent.intentId);
    if (index !== -1 && box[index]!.body !== intent.body) {
      box.splice(index, 1, { intentId: intent.intentId, body: intent.body });
    }
  }

  reconcile(): void {
    if (!this.isClaimOwner()) return;
    if (this.#isDualClaimFrozen()) return;

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

    for (const node of collectReachable(this.getOpenWorkRoots())) {
      if (
        node.state === "running" &&
        !this.table.has(node) &&
        !this.activating.has(node) &&
        !this.hasLiveClaimPeerBind(node)
      ) {
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
    const pew = this.pew;
    const session = this.getSessionPlexus();
    if (pew && session) {
      pew.actors(session).retireClaim();
    }
    this.#claimInstalled = false;
  }

  /** Process-local claim face — what `publishClaim` would write. */
  claimPresence(): ClaimPresenceStatus {
    return {
      binds: [...this.table.keys()],
      acks: [...this.#acks].map(([intentId, ack]) => ({ intentId, state: ack.state })),
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
    const claim = this.claimPresence();
    const catalog = this.catalogPresence();
    this.onClaimPresence(claim);
    this.onCatalogPresence(catalog);

    const pew = this.pew;
    if (!pew) return;

    pew.loaders.publish(catalog);

    const session = this.getSessionPlexus();
    if (!session) return;

    this.#ensureClaimInstalled(session, pew);
    pew.actors(session).publishClaim(claim);
  }

  #ensureClaimInstalled(session: AnyPlexus, pew: PEW): void {
    if (this.#claimInstalled) return;
    pew.actors(session).installClaim();
    this.#claimInstalled = true;
  }

  #isDualClaimFrozen(): boolean {
    const pew = this.pew;
    const session = this.getSessionPlexus();
    if (!pew || !session) return false;
    return pew.actors(session).hasDualClaim;
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
