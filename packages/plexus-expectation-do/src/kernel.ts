import { Plexus } from "@here.build/plexus";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlexus = Plexus<any>;
import {
  Expectation,
  isTerminal,
  Orchestration,
  type EndCause,
  type LaunchDefinition,
  type Lifecycle,
  type TerminalLifecycle,
} from "@here.build/plexus-expectation";
import { Orchestrator, walkExpectationForest, type ExpectationLoader } from "@here.build/plexus-expectation/executor";
import invariant from "tiny-invariant";

import { deriveActorDoName, DurableObjectLoader } from "./actor-do-loader.js";
import { InProcessLoader } from "./in-process-loader.js";
import type { InstallOpts, KernelHandle, SessionRootLike } from "./ports.js";

/**
 * Floor reconcile cadence (proposal §9): an alarm is scheduled at mount time
 * and refreshed on every envelope write. Liveness windows are host policy
 * (design.md §12) — this constant is Stage 1's default, not a claimed tuning.
 */
const ALARM_FLOOR_CADENCE_MS = 30_000;

/**
 * Durable envelope record mirrored to storage on every kernel write (proposal
 * §3 gate). Serialized to a JSON STRING (not a bare object) up front: the
 * matrix's fakes assert on `String(storedValue).includes("running")` /
 * `"sealed"` / `"failed"` / `"supervision"` — stringifying a plain object
 * yields `"[object Object]"`, which would make every value-based assertion
 * unobservable no matter what fields it carries. A JSON string is still
 * trivially JSON-serializable (the hard law), and is what a real DO storage
 * write would hold too (JSON-serialized envelopes, not live class instances).
 */
type EnvelopeRecord = {
  readonly uuid: string;
  readonly kind: string;
  readonly state: Lifecycle;
  readonly endCause: EndCause | "";
  readonly endDetail: string;
  readonly processorClientId: number;
};

/**
 * Storage key scheme: `exp:<uuid>:<field>`. The matrix greps key substrings
 * (`running`, `terminal`, `processorClientId`, `declared`) to assert that a
 * given envelope-write CLASS happened, independent of which entity it was —
 * this scheme keeps those substrings literal in the key while staying
 * per-entity and collision-free.
 */
type EnvelopeField =
  | "running"
  | "processorClientId"
  | "terminal"
  | "declared"
  // Stage 2 additions (proposal §5 actor-DO lifetime protocol): `actorDoName`
  // is the recorded actor-DO id, written durably in the same synchronous
  // turn as `processorClientId` — reconcile's orphan sweep reads it back
  // after eviction, when no in-memory index survives. `actorDoTerminated`
  // is the per-uuid idempotency marker: written BEFORE the (async,
  // fire-and-forget) terminate call so a second sweep — same kernel
  // lifetime or a further restart — never double-terminates.
  | "actorDoName"
  | "actorDoTerminated";

function envelopeKey(uuid: string, field: EnvelopeField): string {
  return `exp:${uuid}:${field}`;
}

function envelopeValue(E: Expectation): string {
  const record: EnvelopeRecord = {
    uuid: E.uuid,
    kind: E.kind,
    state: E.state,
    endCause: E.endCause,
    endDetail: E.endDetail,
    processorClientId: E.processorClientId,
  };
  return JSON.stringify(record);
}

/** Parent-first subtree walk over the PUBLIC `children` accessor (design.md §4 tree law). */
function subtreeOf(root: Expectation): Expectation[] {
  const out: Expectation[] = [];
  const walk = (node: Expectation): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Declare-port parent lookup (proposal §7 G15/G16): the whole open-work forest, not just one tree. */
function findExpectationByUuid(roots: readonly Expectation[], uuid: string): Expectation | undefined {
  for (const node of walkExpectationForest(roots)) {
    if (node.uuid === uuid) return node;
  }
  return undefined;
}

/**
 * The DO host's kernel: an `Orchestrator` (from `@here.build/plexus-expectation/executor`)
 * whose durable writes are mirrored into `opts.storage` in the SAME
 * synchronous turn as the in-memory CRDT apply (proposal §3 durability gate).
 *
 * WHY OVERRIDE `activate`/`fold` RATHER THAN INSTRUMENT THE WRITE SITES: the
 * actual durable writes (`E.transitionState("running")`,
 * `E.processorClientId = ...`, `E.applyTerminal(...)`) happen inside
 * `Orchestrator`'s private critical sections, in a SEPARATE, unmodifiable
 * package (this task's scope is `plexus-expectation-do` only). `activate` and
 * `fold` are `Orchestrator`'s only PUBLIC entry points that perform durable
 * writes, and `Orchestrator`'s own internals call them via `this.activate(...)`
 * / `this.fold(...)` — ordinary prototype dispatch, so a subclass override is
 * invoked even when `reconcile()`/`disposeLease()` (inherited, unmodified)
 * call them internally. Calling `super.xxx(...)` first and mirroring
 * synchronously right after it returns — no `await`, no yield to the
 * microtask queue in between — satisfies the no-await rule (design.md §7)
 * without touching `Orchestrator`'s internals.
 *
 * FIDELITY GAP (documented, not a Stage 1 test row): `Orchestrator.activate`
 * itself calls `this.fold(E, "failed", "crash", ...)` synchronously when
 * `loader.spawn` throws, BEFORE `activate` returns to us — so a spawn that
 * throws immediately is captured as one "failed" terminal mirror (via the
 * `fold` override below) without a separate transient "running" mirror entry.
 * The real platform-level guarantee (a literal write-then-write inside the
 * critical section) needs a workerd-pool test with true output-gate
 * visibility, per this package's test file's own top comment — no in-scope
 * Stage 1 row exercises a throwing spawn.
 *
 * FAILURE LAW (proposal §3): a `storage.put` failure after the CRDT apply
 * must surface loudly so the host can `ctx.abort()`. The mirror calls below
 * are NOT wrapped in try/catch — a throwing `StoragePort` propagates straight
 * out of `activate`/`fold`, out of `reconcile`/`dispose`, to the caller. This
 * is the throw site the failure law refers to; do not add a catch here.
 */
class DoOrchestrator extends Orchestrator {
  #reconciling = false;

  constructor(private readonly opts: InstallOpts) {
    super();
  }

  /** Mount-time setup: floor-cadence alarm + optional self-registration on the fake's `onFire` hook (proposal §9). */
  mount(): void {
    this.#scheduleAlarm();
    // Real Cloudflare has no addEventListener-style alarm callback: the DO
    // class's own `alarm()` handler is what the platform invokes, and the
    // host calls `KernelHandle#reconcile()` from there directly. `onFire` is
    // an optional convenience some `AlarmPort`s (the matrix's fake included)
    // offer for self-wiring; real hosts need not implement it.
    this.opts.alarms.onFire?.(() => this.reconcile());

    // Declare port + presence hub wiring (proposal §7 G15/G16, §8 G10):
    // `InProcessLoader` is the one seam this package controls for augmenting
    // an in-process actor's `LaunchContext` (see in-process-loader.ts's
    // preamble for why `Orchestrator`'s own critical section cannot be
    // instrumented for this). Every such loader registered by the host is
    // bound to THIS kernel's authorship closure and presence hub exactly
    // once, before any spawn can occur.
    for (const loader of this.opts.loaders.values()) {
      if (loader instanceof InProcessLoader) {
        loader.__bindDoHost({
          mintChild: (parentUuid, kind, fields) => this.#mintDeclaredChild(parentUuid, kind, fields),
          presenceHub: this.opts.presence,
        });
      }
    }
  }

  // ── host surface (Orchestrator abstracts) ──────────────────────────────

  getOrchestration(): Orchestration {
    return this.opts.launchers as Orchestration;
  }

  getLoader(def: LaunchDefinition): ExpectationLoader | undefined {
    return this.opts.loaders.get(def.constructor as abstract new (...args: never[]) => unknown) as
      | ExpectationLoader
      | undefined;
  }

  isClaimOwner(): boolean {
    // DO identity IS the mutual-exclusion primitive (proposal §1): a DO id
    // addresses at most one live instance, globally — no arbitration protocol
    // is owed here. The presence-based dual-claim tripwire (design.md §12) is
    // a later-stage concern; no Stage 1 matrix row exercises it.
    return true;
  }

  getOpenWorkRoots(): readonly Expectation[] {
    return (this.opts.root as SessionRootLike).openWork;
  }

  walkCandidates(): Iterable<Expectation> {
    // Forest-orphan detection (design.md §11 sweep 2) needs a superset of
    // "every entity known to the doc," which Stage 1's port surface doesn't
    // model (no whole-doc entity index reaches InstallOpts). Documented gap:
    // no in-scope Stage 1 row exercises forest orphans, only tree/claim
    // orphans reachable from `getOpenWorkRoots()`.
    return [];
  }

  hasLiveClaimPeerBind(_E: Expectation): boolean {
    // No peer-presence dual-claim detection wired in Stage 1 (see isClaimOwner).
    return false;
  }

  getSessionPlexus(): AnyPlexus | null {
    // Stage 1: InstallOpts has no session Plexus handle — only the root entity
    // and a PresenceHubPort for InProcessLoader override. PEW claim/actor mint
    // on Orchestrator stays process-local (createPew default null) until the
    // host ports a real session Plexus (named follow-up: PEW §17 on DO).
    return null;
  }

  // createPew default null — InProcessLoader still injects opts.presence for
  // in-process actor reports (loader-level, not Orchestrator PEW).

  // ── envelope-write mirror (proposal §3 gate) ────────────────────────────

  override activate(E: Expectation): void {
    const wasRunning = E.state === "running";
    super.activate(E);
    if (!wasRunning && E.state === "running") {
      // RUNNING-FIRST (design.md §7): by the time `super.activate` returns
      // having reached `running`, BOTH the state write and the
      // `processorClientId` write already happened inside its synchronous
      // critical section — mirror both together, still before yielding.
      this.opts.storage.put(envelopeKey(E.uuid, "running"), envelopeValue(E));
      this.opts.storage.put(envelopeKey(E.uuid, "processorClientId"), envelopeValue(E));

      // Actor-DO lifetime protocol (proposal §5 G4/G12/LC5): record the
      // actor-DO name in the SAME synchronous turn, but only for plans
      // loaded through a DurableObjectLoader — in-process triads have no
      // actor DO to sweep. `deriveActorDoName` is a pure function of the
      // uuid alone, so the kernel computes it independently here; it does
      // not need the loader to report back what name it used.
      const plan = this.resolvePlan(E.kind);
      if (plan.status === "bound" && this.getLoader(plan.def) instanceof DurableObjectLoader) {
        this.opts.storage.put(envelopeKey(E.uuid, "actorDoName"), deriveActorDoName(E.uuid));
      }

      this.#scheduleAlarm();
    }
  }

  override fold(root: Expectation, terminal: TerminalLifecycle, cause: EndCause, detail?: string): void {
    const wasTerminal = new Map<Expectation, boolean>();
    for (const node of subtreeOf(root)) wasTerminal.set(node, isTerminal(node.state));
    super.fold(root, terminal, cause, detail);
    for (const node of subtreeOf(root)) {
      if (wasTerminal.get(node) === false && isTerminal(node.state)) {
        this.opts.storage.put(envelopeKey(node.uuid, "terminal"), envelopeValue(node));
      }
    }
    this.#scheduleAlarm();
  }

  // ── reconcile re-entrancy guard (proposal §9) ───────────────────────────

  override reconcile(): void {
    // One entry point shared by alarm fire, wake, and doc reactions; nested
    // re-entry (e.g. something synchronously triggering another reconcile
    // from inside this one) is a no-op, not a second sweep.
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      super.reconcile();
      // Runs AFTER super.reconcile(): a claim-orphan fold inside that call
      // (running, no local handle, no live peer bind → failed/supervision)
      // can make a node terminal in THIS SAME sweep — the actor-DO sweep
      // below must see that fresh terminal, not wait for the next pass.
      this.#sweepOrphanActorDos();
    } finally {
      this.#reconciling = false;
    }
  }

  /**
   * Orphan actor-DO sweep (proposal §5 G4/G12/LC5): a durable terminal fold
   * does NOT imply the actor DO's compute stopped — self-termination is
   * never trusted as the only line of defense. Every terminal entity whose
   * resolved plan is loaded through a `DurableObjectLoader` gets `terminate`
   * re-issued, exactly once per E uuid: the `actorDoTerminated` marker is
   * written durably BEFORE the (fire-and-forget) terminate call, so a second
   * sweep in this lifetime — or a sweep after a FURTHER restart — is a
   * no-op. Walks the whole open-work forest each call; a no-op sweep costs
   * nothing (design.md §11), so no separate dirty-tracking is warranted.
   */
  #sweepOrphanActorDos(): void {
    for (const node of walkExpectationForest(this.getOpenWorkRoots())) {
      if (!isTerminal(node.state)) continue;
      const plan = this.resolvePlan(node.kind);
      if (plan.status !== "bound") continue;
      const loader = this.getLoader(plan.def);
      if (!(loader instanceof DurableObjectLoader)) continue;
      const terminatedKey = envelopeKey(node.uuid, "actorDoTerminated");
      if (this.opts.storage.get(terminatedKey)) continue;
      // Marker-before-terminate: prevents double-termination, at the cost of
      // the inverse leak — death between these two statements durably marks an
      // actor "terminated" whose terminate RPC never fired. Accepted: the
      // actor-side self-terminate-on-channel-drop backstop (proposal §5)
      // bounds that orphan, so the sweep never needs to retry.
      this.opts.storage.put(terminatedKey, "1");
      void loader.terminate(deriveActorDoName(node.uuid));
    }
  }

  /**
   * Declare-port authorship (proposal §7 G15/G16): the actor's REQUEST arrives
   * here as three plain values (parent uuid, kind, fields) — this is the ONLY
   * place that ever touches the session doc or storage on the request's
   * behalf, which is what makes "the actor holds no durable pen" true in code,
   * not just in the port's type. ONE RECORD, ONE WRITER: the mint is authored
   * by the host (this method), never by the actor.
   *
   * Mint atomicity (DECLARATION FREEZE / proposal LC11): fields and homing
   * land in ONE Plexus transaction — no observer can see the child `declared`
   * without its fields, or homed-but-fieldless. Homing the child under the
   * ALREADY-reachable `parent` satisfies the work-roots law for free: the
   * child is transitively reachable from the session root the instant this
   * transaction commits (design.md §11 — "an entity must be reachable from
   * the declared roots in the same transaction that creates it").
   *
   * The kernel does NOT activate the child synchronously here: like any other
   * `declared` entity, it is picked up by the next `reconcile()` sweep (alarm,
   * wake, or doc reaction) — proposal §7's "the kernel activates it" is a
   * reconcile-cadence claim, not a same-tick one, and forcing a nested
   * `this.activate(...)` from inside a live `spawn()` call risks re-entering
   * the very critical section this request originated from.
   */
  #mintDeclaredChild(parentUuid: string, kind: string, fields: Record<string, unknown>): string {
    const parent = findExpectationByUuid(this.getOpenWorkRoots(), parentUuid);
    invariant(parent, `declare-port: requesting Expectation "${parentUuid}" is not reachable from the open-work roots`);
    const factory = this.opts.childFactories?.get(kind);
    invariant(factory, `declare-port: no child factory registered for kind "${kind}" (InstallOpts#childFactories)`);
    const child = factory();
    const doc = parent.__doc__;
    invariant(doc, "declare-port: parent Expectation is not materialized into a doc");

    Plexus.connect(doc).transact(() => {
      Object.assign(child, fields);
      parent.children.push(child);
    });

    // Envelope-write mirror (proposal §3 gate), same synchronous turn — no
    // `await` between the CRDT apply above and this storage write. Reuses the
    // `"declared"` field tag the matrix's key-substring assertions grep for.
    this.opts.storage.put(envelopeKey(child.uuid, "declared"), envelopeValue(child));
    this.#scheduleAlarm();
    return child.uuid;
  }

  #scheduleAlarm(): void {
    this.opts.alarms.set(Date.now() + ALARM_FLOOR_CADENCE_MS);
  }
}

/**
 * Mount the PEW kernel in a DO. The RunnerDO (project-id exclusion) is the kernel HOME; it
 * installs one kernel per SESSION doc (contract §12, proposal §1 two-doc topology) — the
 * launcher registry arrives from the kernel doc via {@link InstallOpts#launchers}.
 */
export function installKernel(opts: InstallOpts): KernelHandle {
  const orchestrator = new DoOrchestrator(opts);
  orchestrator.mount();

  return {
    reconcile: () => orchestrator.reconcile(),
    dispose: async () => {
      // disposeLease (inherited, unmodified): one fold pass over held work —
      // SETTLEMENT PREFERENCE does the drain (finished work folds sealed, the
      // rest cancelled/supervision) — where "held" = live local handle or
      // activation in flight (`this.table` ∪ `this.activating`), then reap
      // releases process-plane state. Our `fold` override mirrors every
      // newly-terminal node it produces, so the durable half of "fold, then
      // release" is already covered without extra wiring here.
      orchestrator.disposeLease("do_dispose");
    },
  };
}
