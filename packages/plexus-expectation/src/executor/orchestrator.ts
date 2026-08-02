import { PlexusAwareness } from "@here.build/plexus";
import { observable } from "mobx";

import type { ExpectationLoader } from "./expectation-loader.js";
import type {
  ActorHandle,
  CancellationResult,
  KernelPresenceStatus,
  LaunchContext,
  LoaderHealth,
  LogPort,
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

/**
 * PEW kernel — the claim owner's process face over one session doc.
 *
 * EXECUTION MODEL (design.md §7). The kernel is a single-threaded event loop,
 * and two critical sections are SYNCHRONOUS BY CONTRACT — no `await`, no yield
 * to the microtask queue inside them:
 *
 *   1. activation: plan resolution → `running` write → spawn →
 *      `processorClientId` write → table.set;
 *   2. the fold: terminal check → subtree snapshot → durable writes → reap.
 *
 * This is what makes "first writer wins" true and TOCTOU interleavings
 * (fold-vs-fold, fold-vs-activation) unrepresentable in one process, rather
 * than defended by locks. An `await` introduced inside either section is a
 * correctness regression even if every test stays green. Cross-process
 * concurrency is governed by the writer lease (design.md §12) — presence-based
 * dual-claim detection is an advisory tripwire, not the mutual exclusion.
 *
 * ONE RECORD, ONE WRITER: every durable write on an Expectation after the
 * authorship phase happens HERE (or in entity actions this class invokes).
 * Actors report; the kernel folds. There is no other durable pen.
 */
export abstract class Orchestrator {
  readonly table: Map<Expectation, TableEntry> = new Map();
  readonly activating: Set<Expectation> = new Set();

  readonly #loaderHealth = new Map<string, LoaderHealth>();
  readonly #mailboxes = new Map<Expectation, MailboxEntry[]>();
  readonly #acks = new Map<string, { state: IntentAckState; target: Expectation | null }>();

  // ── host surface ───────────────────────────────────────────────────────────

  abstract getOrchestration(): Orchestration;

  /** Loader association is by LaunchDefinition class — `instanceof`, never string kind. */
  abstract getLoader(def: LaunchDefinition): ExpectationLoader | undefined;

  abstract isClaimOwner(): boolean;

  /**
   * The host's declared work roots. Root registration must be transactional
   * with entity homing (design.md §11) — an entity unreachable from here is
   * forest-orphan territory.
   */
  abstract getOpenWorkRoots(): readonly Expectation[];

  abstract walkCandidates(): Iterable<Expectation>;

  abstract hasLiveClaimPeerBind(E: Expectation): boolean;

  /** Session hub for actor presence clients; null = no presence plane (tests). */
  abstract getPresenceHub(): PlexusAwareness | null;

  /** Publish the kernel's own presence record (binds, loader health, intent acks). */
  abstract publishKernelPresence(status: KernelPresenceStatus): void;

  /** Live steering intents observed from peers' presence records (excluding self). */
  getAuthorIntents(): readonly IntentRecord[] {
    return [];
  }

  /** Host-provided audit sink handed to actors via LaunchContext; core never reads it. */
  getLogPort(): LogPort | undefined {
    return undefined;
  }

  // ── plan resolution ────────────────────────────────────────────────────────

  /** Guards (design.md §4): `missing` = no definition for kind; `refused` = definition, no loader here. */
  resolvePlan(kind: string): PlanResolution {
    const def = this.getOrchestration().plans.get(kind);
    if (def === undefined) return { status: "missing" };
    return this.getLoader(def) === undefined ? { status: "refused", def } : { status: "bound", def };
  }

  // ── activation ─────────────────────────────────────────────────────────────

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
      this.#ensureLoaded(kind, loader);
      return;
    }

    // ── synchronous critical section — no await below this line ──
    this.activating.add(E);
    try {
      E.transitionState("running"); // RUNNING-FIRST (design.md §7)

      const controller = new AbortController();
      const presence = this.#mintPresencePort();
      const mailbox = this.#ensureMailbox(E);
      const ctx: LaunchContext = {
        input: E.snapshotInput(),
        definition: def.toSnapshot(),
        signal: controller.signal,
        presence: presence.port,
        mailbox: { entries: mailbox },
        log: this.getLogPort(),
      };

      let handle: ActorHandle;
      try {
        handle = loader.spawn(ctx);
      } catch (error) {
        presence.destroy();
        this.fold(E, "failed", "crash", `spawn: ${String(error)}`);
        return;
      }

      E.processorClientId = handle.clientId;
      this.table.set(E, { handle, controller, releasePresence: presence.destroy });
      handle.onControlOutcome((o) => this.#applyIntentOutcome(o.intentId, o.outcome));
      handle.settled
        .then(() => this.fold(E, "sealed", "settled"))
        .catch((error: unknown) => this.fold(E, "failed", "crash", String(error)));
    } finally {
      this.activating.delete(E);
    }
    this.#publish();
  }

  #ensureLoaded(kind: string, loader: ExpectationLoader): void {
    const health = this.#loaderHealth.get(kind);
    // A failed load is sticky until rebootstrap — re-firing per sweep is the hot loop §9 forbids.
    if (health === "loading" || health?.startsWith("failed:")) return;
    this.#loaderHealth.set(kind, "loading");
    this.#publish();
    void this.#runLoad(kind, loader);
  }

  async #runLoad(kind: string, loader: ExpectationLoader): Promise<void> {
    try {
      await loader.load();
      this.#loaderHealth.set(kind, "loaded");
      this.#publish();
      this.reconcile();
    } catch (error) {
      // Open work stays open, visible against this record; re-attempt is on
      // plan change or explicit rebootstrap — never a hot loop (design.md §9).
      this.#loaderHealth.set(kind, `failed:${String(error)}`);
      this.#publish();
    }
  }

  /** Host hook after a plan/loader registration change: retry failed loads once, then reconcile. */
  rebootstrap(): void {
    for (const kind of this.#loaderHealth.keys()) {
      const health = this.#loaderHealth.get(kind);
      if (health !== undefined && health.startsWith("failed:")) {
        this.#loaderHealth.delete(kind);
      }
    }
    this.reconcile();
  }

  // ── the fold ───────────────────────────────────────────────────────────────

  /**
   * The single end function — tree-scoped, first-writer-wins (design.md §7).
   * Snapshots settlements and frames BEFORE aborting (abort-reaction frames
   * and settlements are cooperative-cancel territory, deliberately unread),
   * then descendants leaves-first, root last.
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

  /** SETTLEMENT PREFERENCE: an actor that finished beats whatever trigger arrived the same tick. */
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
        node.applyTerminal("sealed", "settled", "", frame, s.result);
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

  // ── control plane ──────────────────────────────────────────────────────────

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

  // ── steering intents ───────────────────────────────────────────────────────

  /**
   * Fold observed author intents into admission state. Called from reconcile;
   * hosts also call reconcile on presence change. Retract = record gone from
   * the author's presence; reshape = body change in place.
   */
  admitIntents(): void {
    const intents = this.getAuthorIntents();
    const liveIds = new Set(intents.map((i) => i.intentId));

    for (const [intentId, ack] of this.#acks) {
      if (liveIds.has(intentId)) continue;
      this.#removeMailboxEntry(ack.target, intentId);
      this.#acks.delete(intentId);
    }

    for (const intent of intents) {
      const existing = this.#acks.get(intent.intentId);
      if (existing !== undefined) {
        if (existing.target !== null && existing.target.uuid !== intent.targetUuid) {
          // Same intentId aimed at a different target: a second, distinct request.
          continue;
        }
        this.#reshapeMailboxEntry(existing.target, intent);
        continue;
      }

      const target = this.#findByUuid(intent.targetUuid);
      if (target === undefined) {
        this.#acks.set(intent.intentId, { state: "refused:target_unbound", target: null });
        continue;
      }
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

  // ── supervision ────────────────────────────────────────────────────────────

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

  /**
   * Yield claim ownership: one fold pass over held work. SETTLEMENT PREFERENCE
   * does the drain — finished work folds sealed, the rest cancelled.
   */
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

  // ── presence ───────────────────────────────────────────────────────────────

  snapshotPresence(): KernelPresenceStatus {
    return {
      binds: [...this.table.keys()].map((E) => ({ uuid: E.uuid })),
      loaders: Object.fromEntries(this.#loaderHealth),
      acks: [...this.#acks].map(([intentId, ack]) => ({ intentId, state: ack.state })),
    };
  }

  #publish(): void {
    this.publishKernelPresence(this.snapshotPresence());
  }

  #mintPresencePort(): { port: PresencePort; destroy: () => void } {
    let minted: { destroy(): void } | null = null;
    const port: PresencePort = {
      mintClient: () => {
        const hub = this.getPresenceHub();
        if (!hub) {
          const inert = { clientID: 0, setReport: () => {}, destroy: () => {} };
          minted = inert;
          return inert;
        }
        const client = PlexusAwareness.createLocalClient(hub);
        const wrapped = {
          clientID: client.clientID,
          setReport: (frame: unknown) => client.setField("report", frame as Parameters<typeof client.setField>[1]),
          destroy: () => client.destroy(),
        };
        minted = wrapped;
        return wrapped;
      },
    };
    return { port, destroy: () => minted?.destroy() };
  }

  #findByUuid(uuid: string): Expectation | undefined {
    for (const node of collectReachable(this.getOpenWorkRoots())) {
      if (node.uuid === uuid) return node;
    }
    for (const node of this.walkCandidates()) {
      if (node.uuid === uuid) return node;
    }
    return undefined;
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

/** Parent-first subtree order; the fold reverses the tail for leaves-first endings. */
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
