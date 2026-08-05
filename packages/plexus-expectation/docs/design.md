# PEW design

**Package:** `@here.build/plexus-expectation`
**Status:** contract, aligned 2026-08-05 — the kernel core (§1–§12) and the presence layer
(§17) both match the implementation. The awareness substrate guarantees §17 leans on live in
plexus (`plexus/docs/awareness-coherence.md`, `plexus/docs/liminal-grounding.md`).
**Audience:** implementers of claim-owner hosts and product Expectation triads.

This is the only design document for PEW.

---

## 1. Problem

Agentic and long-running work needs:

1. Identity that **survives process death** (CRDT document).
2. **Live progress** while open — streamed eagerly, not rendered after completion.
3. **Nested work** under one supervision law (structured concurrency).
4. Exactly one process that may **resolve** a given unit (**claim owner**).
5. A **renderable ending** — every terminal, including cancellation, carries the work's last
   reported state.

Splitting these into job rows + streams + session phases + checkpoints produces dual books.
PEW keeps one durable noun (Expectation), one kernel process face, and three isolated planes.

---

## 2. Planes and the ownership law

| Plane | Substrate | Contents |
|-------|-----------|----------|
| **Durable** | Plexus CRDT | Expectation tree, LaunchDefinition registry, terminal records |
| **Awareness** | Plexus presence (ephemeral) | Actor state updates, steering intents, kernel status (acks, binds, loader health), loader capability records |
| **Process** | Claim-owner memory | Kernel table, loaders, actor handles |

**ONE RECORD, ONE WRITER.** Every record has exactly one writer, fixed by plane and phase:
a host AUTHORS an Expectation, and the authorship phase lasts until the **kernel's first durable
write** on the entity — from that write onward the KERNEL owns every durable write on it; on
awareness, every participant writes ONLY its own presence record; actors write nothing durable,
ever.

Why this is the only consistent rule, not a convention: every alternative splits authority and
forces reconciliation machinery between the copies.

- *Actor-writes-durable-when-healthy* requires the kernel to detect "healthy," produces a
  per-end-path case analysis (did the actor already write?), and forces a process-local mirror of
  the durable FSM with resync logic — two copies of one state.
- *Kernel-relays-progress* puts a process hop inside the hot streaming path and gives the
  durable-plane owner authority over an ephemeral plane it does not own.
- *Shared presence records* (two writers on one key) reintroduce last-writer-wins races the plane
  split exists to remove.

**DECLARATION FREEZE.** Declaration fields and `declared` land in ONE mint transaction — a
reconciler can never observe a half-declared entity. The author may amend its own declaration
(transactionally) or cancel its own work (§10) while the authorship phase lasts; the kernel's
first write ends the phase, after which declaration fields are frozen and the `input` snapshot
taken at spawn is the execution's authoritative view.

Scope and enforcement:

- The law governs the **Expectation plane**. A host's own books (its journal, its logs) are the
  host's records — dual-writing them during migration does not touch this law; product truth for
  "is this still owed?" is PEW (§13).
- Exclusivity is enforced by the **import split** (§14) and the kernel-only executor API, not by
  substrate ACLs — Plexus accepts any write from any doc holder. A foreign write to a
  kernel-owned field (or a post-freeze declaration write) is a host bug; the FSM guards catch the
  detectable subset (illegal transitions throw), the rest is review discipline.

Eagerness is preserved by plane assignment, not writer discipline: streaming state lives on the
awareness plane, which the actor owns and writes directly with zero kernel hops. Durable writes
are envelope transitions — a handful per Expectation lifetime, none latency-sensitive.

---

## 3. The triad

Extension unit: one Expectation subclass, its LaunchDefinition subclass, its actor class — bound
**by class, not by string**. The string `kind` survives only where a CRDT map needs a serializable
key (the `Orchestration.plans` registry and wire advertisements); no process-side dispatch keys
on it.

```ts
class ToolCallExpectation extends Expectation<ToolResult, ToolReport> {
  static readonly kind = "harness.tool_call";
  @syncing accessor name = "";       // declaration field — authored at mint
  @syncing accessor argsJson = "{}"; // declaration field — authored at mint

  applySettlement(result: ToolResult): void { /* typed product-field writes */ }
}

class ToolCallLaunchDefinition extends LaunchDefinition { /* durable config */ }

class ToolCallActor extends ExpectationActor<ToolCallInput, ToolResult, ToolReport> {
  /* internal logic — any shape: state machine, buffer, array */
}
```

Type parameters:

| Param | Home | Contract |
|-------|------|----------|
| `TResult` | settlement → `applySettlement` | product outcome shape; each triad's own (dict, array, tuple — no shared shape imposed) |
| `TReport` | awareness updates + `lastReportJson` | **must be JSON-serializable** — serialized at publish, so violations fail loudly at the first report, not at the terminal fold |
| `TInput` | `LaunchContext.input` | snapshot of declaration fields at spawn, produced by the Expectation subclass |

The kernel owns **when** durable writes happen; the subclass owns **what** they mean.
`applySettlement` runs inside the kernel's terminal transaction — entity-typed logic, kernel-held
pen. The kernel itself is generic over triads: `ActorHandle` surfaces are `unknown`-typed at the
kernel boundary and typing re-establishes entity-side (`applySettlement`) and actor-side
(`ExpectationActor` generics) — a generically-typed kernel is not a missing feature.

---

## 4. Expectation faces and lifecycle

One entity, four views (not four types):

| Face | Mechanism |
|------|-----------|
| Promise | settles to exactly one terminal: `sealed` \| `failed` \| `cancelled`; terminals are final |
| Generator | live state via the actor's awareness record; final frame folded durably at terminal |
| FSM | the graph below; kernel-applied; illegal writes throw |
| Continuation | one execution per entity — death ends THIS Expectation; retry mints a new one |

### Lifecycle graph

```text
declared ──► missing | refused | running | cancelled
missing  ──► running | refused | cancelled
refused  ──► missing | running | cancelled
running  ──► sealed | failed | cancelled
sealed | failed | cancelled  = final
```

Plan-resolution guards: `missing` = no LaunchDefinition registered for the kind; `refused` =
definition registered, but no loader association on this host. Both are re-resolved on every
reconcile sweep (§11) — registration of the definition or the loader moves the entity onward;
neither state is permanent by construction, only by circumstance.

Same-state writes are no-ops. Illegal transitions throw `PewTerminalWriteError` — reserved for
genuine bugs; **races between end triggers are not illegal writes**: the end fold treats an
already-terminal node as a no-op (§7), and fold atomicity is guaranteed by the execution model
(§7), not by check-then-write hope.

The machine is pure transition law. It contains **no commands**: "activatable" is a kernel
predicate derived FROM the graph (open, non-running states), not an event fired INTO it. The
alternative — scheduling verbs as machine events with host-provided actions — wires the kernel
into the entity grammar and turns the FSM into an RPC router.

### Terminal record

Every terminal carries, in one kernel transaction:

| Field | Content |
|-------|---------|
| `state` | `sealed` \| `failed` \| `cancelled` |
| `endCause` | `settled` \| `surface` \| `cancel` \| `supervision` \| `crash` |
| `endDetail` | diagnostic string (fail reason, cancel reason, crash error, `applySettlement` error); non-string reasons are `String()`-coerced |
| `lastReportJson` | the actor's final buffered frame (§6); `null` when the work never reported |
| product fields | via `applySettlement`, seal path only |

`endCause` discriminates what the bare terminal cannot: lease yield and user cancel both end
`cancelled` (`supervision` vs `cancel`); claim orphan and tool error both end `failed`
(`supervision` vs `settled`). Downstream retry/display policy keys on the pair, never on the
terminal alone. **Partial-apply marker:** `sealed` + non-null `endDetail` means "envelope sealed,
product apply incomplete" (§7) — downstream treats it as degraded success, never silently as full
success.

### Tree law

- `children` is owned (`@syncing.child.list`).
- Every ending is tree-scoped (§7): live actors in the subtree are aborted first, descendants
  reach their terminals leaves-first, and the root's terminal commits **last** — a durable
  terminal parent with durably open children is a reconcile-repairable anomaly (§11), never a
  state the fold itself produces.
- Orphans (tree or forest) are cancelled by reconcile, never re-executed.

---

## 5. Channels

**SIMPLEX LAW.** The kernel never CALLS INTO an actor: the AbortSignal an actor is born with is
the only kernel-initiated signal it will ever receive. Everything the actor sends is
fire-and-forget; no channel carries a response to another channel. Steering reaches the actor as
**observable data it reads at its own pace** — a downward data plane, deliberately not a call
plane.

| Channel | Direction | Plane | Content |
|---------|-----------|-------|---------|
| Updates | actor → world | awareness | actor-shaped `TReport`; not durable while open; final frame folded at terminal |
| Settlement | actor → kernel | process (once) | `complete(result)` \| `fail(reason)` — buffered synchronously on the handle at emit (§7), promise resolves after |
| Control outcomes | actor → kernel | process | per-intent `considered` \| `dropped`; success-or-error, no payload, uncorrelated with updates |
| Cancel | kernel → actor | AbortSignal | the only kernel-initiated signal |
| Mailbox | kernel-maintained, actor-observed | process | read-only view of admitted live intents; data, not callbacks |

The mailbox is a view the actor polls or observes — the alternative (delivery callbacks into the
actor) is a duplex control channel that forces hook-forwarding boilerplate through every loader
and actor layer, plus bind-time flush choreography.

### Core process types

```ts
type Settlement<TResult> =
  | { readonly outcome: "complete"; readonly result: TResult }
  | { readonly outcome: "fail"; readonly reason: unknown };

type IntentOutcome = {
  readonly intentId: string;
  readonly outcome: "considered" | "dropped";
};

type MailboxEntry = {
  readonly intentId: string;
  readonly body: unknown; // current revision — in-place edits replace it (§8)
};

type LaunchContext<TInput> = {
  readonly input: TInput;
  readonly definition: LaunchDefinitionSnapshot;
  readonly signal: AbortSignal;
  readonly presence: PresencePort;   // mints the actor's awareness client on the session hub
  readonly mailbox: MailboxView;     // observable readonly MailboxEntry[]
};

type ActorHandle = {
  readonly settled: Promise<Settlement<unknown>>;
  readonly clientId: number;              // session-hub presence id; never 0 when minted; 0 = unassigned
  settlement(): Settlement<unknown> | null; // sync buffer, set at emit — folds consult it first
  lastReport(): unknown | null;             // kernel-side frame buffer — §6
  onControlOutcome(sink: (o: IntentOutcome) => void): void;
};
```

Port contracts (one line each): `PresencePort` mints at most one awareness client per spawn, on
the session hub; `MailboxView` is a read-only observable list whose entries the kernel adds and
removes.

---

## 6. Progress and the last-report law

The actor base class owns the whole updates pipeline:

- It mints its own awareness client at spawn through `ctx.presence`. The client always lives on
  the **session hub** (cross-process runners relay through their adapter onto the session hub),
  so `clientId` is hub-unique and the durable discovery pointer is unambiguous. PEW never mints
  `clientId === 0` (plexus-internal reservation). Unassigned `processorClientId` (durable default
  0) means no presence client — inert surface actors leave it unassigned.
- Reports are serialized at publish. A report that fails to serialize is an actor error: the
  actor takes the crash fold, and the buffer keeps the last **good** frame. **Latest frame wins —
  that is the whole policy.** The core has no report modes: an actor that wants history appends
  inside its own `TReport` shape (`{ log: [...] }`); a policy knob in the core would put the
  durable-plane owner in charge of an ephemeral plane it does not write.
- The kernel records `processorClientId` durably right after spawn, inside the same synchronous
  activation section (§7) — the discovery pointer observers use to find the actor's record.

The kernel is not in the update path. No per-patch relay, no hub state on the durable model class.

**LAST REPORT LAW.** The last successfully-serialized frame is buffered **kernel-side, on the
handle**: by the base class for in-process actors, by the relay adapter for cross-process actors
(the adapter buffer IS the kernel-side truth — there is exactly one buffer per handle, so no
precedence question exists). The end fold reads `handle.lastReport()` before aborting and
persists it as `lastReportJson` on every terminal:

| Ending | Durable record |
|--------|----------------|
| `complete(result)` | `sealed` + `applySettlement(result)` + last report |
| `fail(reason)` | `failed` + reason + last report |
| crash (no settlement) | `failed` + last report from the handle buffer |
| cancel / supervision | `cancelled` + last report |
| surface settle | terminal + `null` report — the disposition IS the answer |

The law's precise claim: the folded frame is the last one published **before the kernel initiated
the ending**. Frames an actor flushes *in reaction to* abort are cooperative-cancel territory
(non-goal, deferred) — the fold does not wait for them. Cross-process, the relay is best-effort:
a frame published but not yet relayed when the runner dies is lost (accepted loss, §12).

A terminal Expectation therefore always renders: the explicit answer, or the last thing the work
said before it ended. This is why `TReport` must be JSON-serializable — the awareness plane's
types are pinned by the durable fold, not by convention.

---

## 7. Spawn and settlement

**EXECUTION MODEL.** The kernel is a single-threaded event loop. Two critical sections are
**synchronous by contract** — no `await`, no yield to the microtask queue inside them:

1. **Activation**: plan resolution → `running` write → `spawn` → `processorClientId` write →
   `table.set`. (`ExpectationLoader.spawn` is synchronous; loaders do async work in `load()`.)
2. **The fold**: terminal check → subtree walk → durable writes → reap.

This is what makes "first writer wins" true and the TOCTOU objections (fold-vs-fold,
fold-vs-activation interleavings) unrepresentable in one process, rather than defended by locks.
Cross-process concurrency is governed by the lease (§12). This rationale lives in the kernel's
file preamble in code — it is a property implementers must preserve, not an annotation.

```text
kernel.activate(E)                     // per-E activation guard; re-entry is a no-op
  resolve plan by kind                 → missing | refused: kernel writes the state; done
                                         (guards: §4 — no definition / no loader association)
  ensure loader loaded                 (async, OUTSIDE the critical section; health in kernel
                                        presence — §9; activation re-enters when load resolves)
  ── synchronous from here ──
  kernel writes running                // BEFORE spawn — see RUNNING-FIRST below
  handle = loader.spawn(ctx)
  kernel writes processorClientId = handle.clientId
  table.set(E, handle)
  handle.settled.then(foldSettled, foldCrash)
```

**RUNNING-FIRST.** The durable `running` write PRECEDES `spawn`. The inverted order (spawn first,
then write) opens two unclosable holes:

- a settlement can arrive while the entity is still `declared` — no legal FSM edge exists into
  `sealed`/`failed` from there, so the result is lost;
- a claim-owner crash between spawn and write leaves the entity activatable — reconcile then
  starts a SECOND execution for the same uuid while the first still runs.

With running-first, a crash anywhere in the activation section leaves `running` + no bind →
claim-orphan → `failed` (§11) — the correct outcome under one-execution. `spawn` throwing takes
the crash fold. A cross-process runner adapter must **self-terminate when the kernel's presence
disappears** (grace window host-tuned, §12); the AbortSignal is process-local and cannot fire
from a dead kernel. The claim-orphan predicate excludes entities whose activation section or
`load()` wait is in flight locally.

**One fold — tree-scoped, first-writer-wins.** Every ending funnels through a single kernel end
function; `requestCancellation`, parent cascade, orphan repair, and lease dispose are all calls
into it:

```text
fold(root, terminal, endCause, endDetail?):
  if root is terminal already → no-op          // first writer wins; races are not errors
  abort every live actor in the subtree
  for each open descendant, leaves-first:
    settleOrEnd(node, cancelled, supervision)
  settleOrEnd(root, terminal, endCause, endDetail)
  reap subtree: drop table entries, release presence, drop mailboxes + acks

settleOrEnd(node, terminal, cause, detail?):
  s = table.get(node)?.settlement()
  if s exists:                                  // SETTLEMENT PREFERENCE — see below
    write s.outcome terminal (+ applySettlement on complete), endCause: settled,
    lastReportJson from handle
  else:
    write terminal, cause, detail, lastReportJson from handle (null if no handle)
```

- **SETTLEMENT PREFERENCE.** `complete`/`fail` is buffered synchronously on the handle at emit —
  before the settlement promise resolves. Any fold consults the buffer first: an actor that
  finished beats the trigger that arrived the same tick, whatever that trigger was (cancel,
  cascade, lease dispose). In-process this closes the lost-result window entirely; cross-process
  relay lag is accepted loss (§12). The lease-dispose "drain" is not a separate mechanism — it is
  this rule applied by the dispose fold.
- **Root terminal commits last.** Children reach their terminals before the parent's write —
  including when the parent settles naturally — so the tree law (§4) is what the fold does, not a
  separate invariant to police.
- **`applySettlement` throwing does not roll back the terminal.** The terminal, cause, and last
  report commit; product fields stay partial; the error lands in `endDetail` — producing the
  partial-apply marker pair (§4): `sealed` + non-null `endDetail`. The alternative — staying
  `running` — resurrects a zombie whose actor is gone.
- Surface triads (human-fulfilled work: approvals) have inert actors; their settlement arrives as
  a kernel operation — `settleSurface(E, disposition)`, valid only for surface-definition kinds
  in `running` — and takes the same fold. The core has no surface timeout: escalation is host
  policy, and the host holding the kernel can always `requestCancellation`.

### End triggers

| Trigger | Terminal | `endCause` |
|---------|----------|------------|
| `complete` / `fail` emission | `sealed` / `failed` | `settled` |
| Surface settle | `sealed` (`allow`/`deny`) or `cancelled` (`abandon`) | `surface` |
| `requestCancellation`; author cancel of unclaimed work (§10) | `cancelled` | `cancel` |
| Parent-terminal cascade, orphan, lease dispose | `cancelled` | `supervision` |
| Claim orphan (running, no local handle, no live peer bind) | `failed` | `supervision` |
| Actor crash / handle rejection / spawn throw | `failed` | `crash` |

There is no rebind generation and no `awaiting_rebind`. Retry is a new Expectation.

---

## 8. Steering intents

Steering is declarative and **ephemeral by design**: intents affect only a live execution. The
guarantee is not presence lifetime — an author's presence outlives any claim owner — but the
admission rule: an intent targets an Expectation **model** (entity identity, never a uuid
string), admission requires that entity to be **locally bound right now**, and one-execution
guarantees that entity's uuid never runs again. A stale "retry now" surviving in an author's
presence is refused against a terminal or unbound target; there is no execution it could ever
reach except the one it was written for.

Protocol (each arrow is a presence write in the writer's OWN record, or a process-local flow):

```text
author presence:  intents: [{ intentId, target /* Expectation model */, body }]
                       │  (kernel observes)
kernel admission: target open + locally bound + definition.acceptsMessages
                  (intentId collisions: first writer wins)   → admitted | refused:<code>
claim presence:   acks: [{ intentId, state: admitted | refused:<code> | considered | dropped }]
                       │  (mailbox view updates)
actor:            observes mailbox at its own pace → emits considered | dropped
kernel:           folds outcome into its claim-record ack
```

- **Acknowledged, no promises.** Admission means "the kernel accepted the request and routed it";
  if the execution ends first, the intent dies with it — admission is not a delivery guarantee.
  `considered` is the actor saying "taken into consideration"; what it did about it shows up (or
  not) in the updates stream, uncorrelated.
- **Retract** = the author removes the intent from their presence. **Reshape** = the author edits
  the body in place. Both are observed as diffs; neither is an API call. There are **no epochs**
  and **no revision correlation**: outcomes correlate by `intentId` only — an author needing to
  know which revision was honored retracts and mints a new `intentId`. Versioning machinery on a
  channel that promises nothing buys nothing.
- Intents targeting a terminal or unbound Expectation are refused at admission — and refusals
  are RE-EVALUATED on later sweeps while the intent stays authored: a target that was mid-load
  ("unbound") admits once it binds. Only `considered`/`dropped` are final acks. Admitted intents
  that outlive their execution vanish with the kernel's ack record at reap — an author observing
  a terminal target and a reaped ack learns "the execution ended; no promise was broken, because
  none was made." An actor's outcome emitted after reap folds into nothing, by the same clause.
- **Steering rights = doc access.** Admission is purely mechanical; any peer that can write the
  session's presence can author intents. Finer-grained authorization is a host-layer concern
  (host filters which peers' presence it feeds the kernel) — rationale for this cut belongs in
  the admission code's preamble.

Example intents (product vocabulary, opaque to PEW): "retry now" (server stuck — steer the live
actor to retry internally; the execution never ended, so one-execution holds), "break early to
steer", "stop and quit as-is".

**There is no intent audit channel.** A synced intent log is a permanent CRDT commitment with
no core consumer, and a process-side log sink is a second record of the world — the doc IS the
record. What steering did to an execution shows up (or not) in the updates stream and the
terminal fold; problems go to stderr. An actor that wants richer history appends inside its own
`TReport` shape.

---

## 9. Loaders

A loader is the hermetic spawning abstraction for one LaunchDefinition class. In-process,
child-process, isolate, remote — invisible above the loader boundary.

```ts
abstract class ExpectationLoader {
  load(): Promise<void>;                    // idempotent; async work lives here
  spawn(ctx: LaunchContext): ActorHandle;   // synchronous — §7 EXECUTION MODEL
}
```

- The kernel never injects itself into a loader or an actor. No host callback bundles, no
  orchestrator binding. The loader gets a context; the kernel gets a handle; the handle's
  surfaces are the only contact.
- **Loader health lives on the orchestration-doc presence (global catalog face, §17).** The
  claim-owner process advertises, per registered plan: loaded, loading, or `failed:<reason>`. A
  failed `load()` leaves the Expectation in its open state, visible against the failure record;
  the kernel re-attempts on plan change or explicit host re-bootstrap, never in a hot loop.
- **Capability: loader-sourced, catalog-published, ADVISORY.** A loader may implement
  `probeCapability(): Promise<LoaderCapability>` — availability status (`ready` / `blocked` with
  an errors-as-doors `door` / `unavailable`) plus the current argument inventory (`args`: models
  list, tool names — the triad's own shape). The kernel probes after a successful `load()` and on
  the host's explicit `refreshCapability()`, and publishes the record on the **orchestration**
  presence alongside loader health — the loader is the source, the catalog pen is PEW. **The
  kernel never interprets it**: no activation gating on `status`, no validating declarations
  against `args` — enforcement stays at `load()` (sticky failed health) and the actor's fail
  path (door in `endDetail`). Capability exists so surfaces can warn BEFORE an execution is
  spent; it must never become a second admission system — inventory is ephemeral and would race
  admission anyway. Inventory is published whole (a thousand OpenRouter models is fine);
  selection stays durable declaration on the LaunchDefinition. A self-managed loader may still
  publish its own presence record instead. Lazy loading on first spawn is the default.
- Loader association is by LaunchDefinition class (`instanceof`), registered on the claim-owner
  host. Two definitions of the same class share a loader; bootstrap state lives on the loader.

---

## 10. Cancellation

- `requestCancellation(E, { strength, reason })` — claim owner; `cooperative` is a typed
  stub-refusal until designed; `immediate` runs the fold with (`cancelled`, `cancel`).
- **Author cancel of unclaimed work.** While the authorship phase lasts (§2 — no kernel write
  yet), the author may durably cancel its own Expectation (`declared → cancelled`,
  `endCause: cancel`). This is the one durable terminal the kernel does not write, and it exists
  because no kernel may exist yet to ask — the alternative leaves ownerless work immortal.
- All supervision endings (parent cascade, orphan repair, lease dispose) are fold calls — cancel
  has no private physics (§7).

---

## 11. Reconcile

The claim owner reconciles on THREE triggers, and all three are load-bearing — a host that
wires only some of them starves the corresponding inputs (a durable-only host never admits
awareness-borne intents; a reactive-only host never repairs after its own missed events):

1. **Durable reactions** — openWork / tree / plan-registry changes.
2. **Session-hub awareness changes** — intents authored/retracted, claim records appearing;
   applying inbound awareness bytes without scheduling a sweep is the canonical host bug.
3. **A floor cadence** — periodic (DO alarm, interval) so missed events self-heal.

Each sweep:

1. Tree orphans (open child under terminal parent) → fold (`cancelled`, `supervision`).
2. Forest orphans (open, unreachable from the host's declared work roots) → fold.
3. Claim orphans (`running`, no local handle **and no local activation in flight**, no live peer
   advertising the bind) → fold (`failed`, `supervision`).
4. Open activatable work → activate (re-resolves the plan each sweep — this is how `missing` and
   `refused` move onward when a definition or loader appears; idempotent and cheap when nothing
   changed, and there is no backoff machinery because a no-op sweep costs nothing).

Reconcile repairs; it never re-executes (one execution per entity).

**Work roots are a host contract.** The host's root registration (its openWork homes) must be
transactional with entity homing: an entity must be reachable from the declared roots in the same
transaction that creates it, or sweep 2 will cancel live work the host merely forgot to
register. PEW treats the root set as authoritative; keeping it truthful is the host's half of the
supervision bargain.

---

## 12. Claim owner

- **Claim ownership rests on the session writer lease** — the host's single-writer arbitration —
  not on presence. One kernel per session doc, installed while holding the lease; disposed on
  yield: one fold pass over held work (settlement preference first — finished work folds sealed,
  the rest `cancelled`/`supervision`), where "held" = every entity with a live local handle or
  activation in flight.
- The claim owner **self-registers** a presence record on the **session** hub under an
  **arbitrary client id** (not the hub base; never `0` — §17). That record carries binds, intent
  acks, and the claim marker. Loader health / capability inventory live on the **orchestration**
  hub instead (global catalog). Presence-based dual-claim detection is **advisory** — a tripwire
  for lease bugs, not the mutual exclusion itself: two live claim-marked peers freeze activation
  on both sides and surface a host error until one yields. During such a window, durable writes
  from both peers land as CRDT LWW — PEW bounds the damage (freeze) but cannot arbitrate it; the
  lease layer must. Observers **rediscover** the claim owner by scanning the hub (MobX-reactive);
  planned reload is **overlapping** (mint+publish before destroy); crash-restart **evicts** stale
  claim peers on install under lease.
- **Liveness windows are host policy.** Presence timeouts (claim-orphan detection, runner
  self-termination grace when the claim record disappears) are host-tuned constants; PEW states
  their consequences, not their values.

- **Accepted-loss ledger** (each entry: the alternative is a second durable writer, which costs
  more than the loss):
  - A network partition can orphan-fail work whose actor is alive on the far side; its late
    settlement folds as a no-op. Retry is a new Expectation.
  - A cross-process frame or settlement published but not yet relayed when the runner dies is
    lost.
  - A mis-tuned liveness window can self-terminate a healthy runner (false presence loss) or
    orphan-fail work under a GC-paused kernel.

---

## 13. There is no journal

The yjs doc is the record. Open-work authority is the Expectation tree; progress is awareness;
terminals carry `endCause`, product fields, and the last report. A host journal is a second book
of the same facts, and every second book eventually disagrees with the first — the only channel
PEW keeps besides the doc and awareness is **stderr, for faults**. A host still migrating off a
journal treats it as debug output on a deletion path, never as a truth source.

---

## 14. Package layout

```text
src/shared/     Expectation, LaunchDefinition*, Orchestration, lifecycle machine, intent types
src/executor/   kernel (Orchestrator), ExpectationLoader, ExpectationActor base, ActorHandle,
                intent admission + mailbox
```

| Import | Who |
|--------|-----|
| `@here.build/plexus-expectation` | any process holding the doc |
| `@here.build/plexus-expectation/executor` | claim owner only — observers must not import it |

PEW knows no LLM, tool, or UI domain names. Product packages ship triads.

---

## 15. Test matrix

Load-bearing invariants and the test that breaks when they break (unit unless noted):

| Invariant | Test |
|-----------|------|
| Kernel-only writes post-declaration | actor/observer attempting `transitionState` on a bound E has no path to do so via public API; foreign-write FSM guard throws |
| DECLARATION FREEZE | mint transaction atomicity: no reconcile observation of declared-without-fields (integration) |
| RUNNING-FIRST | settlement buffered synchronously inside `spawn` still folds correctly; kill-between-write-and-spawn leaves claim-orphanable state (integration) |
| One fold, first-writer-wins | child settles while parent cascade cancels: exactly one terminal per node, second trigger no-ops, no throw |
| Tree-scoped fold | parent settling naturally: children terminal before parent's terminal commits; no durable open-child-under-terminal-parent window from the fold itself |
| SETTLEMENT PREFERENCE | cancel fold against a handle with buffered `complete`: node seals with product fields, `endCause: settled`; same at lease dispose |
| LAST REPORT on every path | one test per end-trigger row asserting `lastReportJson` matches the final good frame; serialize-failure keeps prior frame and takes crash fold |
| `applySettlement` throw | terminal + `endDetail` committed, fields partial, no zombie `running`; partial-apply marker pair readable |
| Author cancel | `declared` entity cancelled by author without any kernel; kernel's first write ends the ability (post-`running` author cancel refused) |
| Intent admission | refused on: terminal target, unbound target, `acceptsMessages: false`; refusal re-admits after bind; intentId collision = first writer wins; target is Expectation model identity |
| No-epoch reshape | in-place body edit visible in mailbox; outcome folds by intentId regardless of revision |
| Dual-claim freeze | two claim-marked presence records on one session hub freezes activation both ways |
| Loader health | failing `load()` appears in orchestration catalog, work stays open, no hot loop; `missing`/`refused` move onward when definition/loader registered |
| Capability | probe published after load and on refresh; probe throw → `unavailable` with the error as door; probe-less loader publishes no record; kernel never gates activation on `status` |
| Claim rediscovery | claim client destroyed → getters null; new claim client under new id → scan finds it; no sticky clientId cache |
| Overlapping reload | during claim-client rotation, at least one claim record is live at every instant; runners do not self-terminate |
| Crash-restart install | on install under lease, stale claim-marked peers are evicted before own publish; no self-freeze on dead predecessor |
| Dual-claim scan includes self | single kernel → `hasDualClaim` false; two kernels (incl. self in each scan) → true |
| reportOf MobX | autorun on `reportOf(E)` re-fires on that peer only; peer isolation |
| reportOf pre-spawn / reap | autorun while unassigned re-fires when pointer becomes a legal client id; after reap returns `undefined` |
| mint never 0 | every `mintActorClient` / claim client has `clientId !== 0` |
| Catalog MobX | autorun on `plans` re-fires on catalog publish, not on actor report noise |
| Catalog merge | kernel health + loader self-capability disagree → stated merge rule holds |
| isBound same-doc | bind list membership by Expectation uuid after tolerant resolve; no uuid strings on the wire |
| isBound unsynced bind | a claim frame referencing unsynced entities is not visible until the doc catches up (substrate coherence gate); becomes visible — and `isBound` true — on catch-up |
| Actor-client reap | after fold reap, hub `getPeer(clientId)` is null / report gone |
| Session hub auto-lifecycle | first use subscribes; hub/doc destroy drops listeners; no attach API |
| plan unknown kind | `plan("unknown")` returns `undefined` |
| readIntents | author intents visible to kernel via PEW; retract drops them |

---

## 16. Rejected shapes

Each of these looks like a simplification or a robustness fix and is rejected because of the
machinery it forces:

- **Actor writes durable lifecycle "when healthy."** Forces the kernel to define healthy, forks
  every end path on "did the actor already write?", and requires a process-local mirror FSM with
  durable-resync — two copies of one state and reconciliation code between them.
- **Spawn before durable `running`.** Opens the settlement-with-no-legal-edge hole and the
  crash-window double-execution; running-first closes both at the cost of one durable write that
  may describe a spawn that instantly fails — which the crash fold handles.
- **Node-scoped fold (parent terminal first, cascade after).** Leaves open children under a
  durable terminal parent for a window the tree law forbids; the tree-scoped fold makes the law
  and the mechanism the same thing.
- **Async critical sections / fold locks.** An `await` between terminal-check and terminal-write
  turns first-writer-wins into TOCTOU; the synchronous-section contract deletes the lock
  machinery a yielding fold would need.
- **Pre-spawn shell actors.** Exist only to route kernel decisions (plan missing/refused) through
  "an actor" for write-discipline symmetry — a fake process minted to satisfy a rule that the
  single-writer law deletes.
- **Delivery callbacks into actors** (`deliverAdjustment`/`retract`/`reshape` hooks). A duplex
  control channel; every loader and actor layer must forward the hooks; bind-time flush
  choreography follows. The mailbox view carries the same information as observable data.
- **Durable intent state.** A synced consumption FSM must be garbage-collected (dead-lettering),
  flushed on bind, and — fatally — survives restarts that the intent semantics forbid.
- **Intent epochs.** Revision arbitration on a channel that promises nothing; retract + new
  intentId covers the rare strict-correlation need with zero core machinery.
- **Progress modes in the core** (`lww`/`append` policy on LaunchDefinition). Puts the durable
  plane in charge of report shape; an actor that wants history appends inside its own `TReport`.
- **Kernel-relayed progress.** Adds a hop per patch in the streaming path and hands the durable
  owner authority over a plane it does not write.
- **Durable settlement buffers / actor-written results.** Would survive partitions, but
  reintroduces the second durable writer and its reconciliation; the accepted losses are stated
  in §12.
- **String-kind process dispatch.** Kind-keyed starter maps push `unknown` through every seam and
  reduce the triad to a stringly-typed registry; class-keyed association keeps every seam typed
  and lets the definition class carry its loader.
- **`PewPlexus extends Plexus` / PEW-owned multi-doc registry.** Composition (`new PEW(plexus)`)
  plus existing family reverse-resolve covers the topology; a parallel registry is dual books.
- **Session Expectation entity refs on the orchestration hub.** Cross-doc awareness serde throws;
  catalog is kind-keyed JSON; execution binds stay on the session hub that owns those entities.
- **Claim owner = hub base clientId.** Breaks ambient reload under a new id; discovery must scan.
- **Imperative presence `onChange`.** MobX is the subscription (same grain as mailbox).
- **Sequential destroy-then-mint claim reload.** Creates an observer-visible claim gap that
  forces runner self-termination; overlapping mint→publish→destroy is required (§17.5).
- **Reader-side tolerance for unresolvable refs** (try/catch scans, null-on-missing deref in
  PEW). Awareness can outrace doc sync, but the remedy is the substrate's coherence gate — the
  incoherent frame is unobservable, readers stay strict, and a failed deref is always a bug
  (§17.3). Coping code in every consumer was the rejected shape.

---

## 17. Presence API (`PEW`)

The awareness plane already holds everything observers need. What was missing is a **typed,
MobX-reactive lens** and a frozen wire split that matches the **two-doc topology**. This section
is the contract for that lens.

**Review status:** dual eng-review (LongCat + Fable, 2026-08-03) verdict **fix-then-go**. This
revision absorbs those findings. Reviews live under `docs/reviews/`.

### 17.1 Two-doc topology

| Doc | Durable contents | Presence face |
|-----|------------------|---------------|
| **Orchestration (kernel)** | `Orchestration.plans` / LaunchDefinition home | **Global catalog** — loader health + capability inventory (kind-keyed; no session entity refs) |
| **Session** | Expectation trees, openWork | **Execution** — claim record (binds, acks), actor `report`s, author intents |

Loaders are available **globally**. Execution only matters **to a specific session**. Putting
session `Expectation`s onto the orchestration hub is forbidden — the substrate's serialization
membrane refuses cross-family references (write half of the coherence law). Catalog payloads are
plain JSON / plan kinds. Session binds are Expectation **models on the session hub that owns
them** — serialized and resolved by the substrate, one live instance per family.

**Observer reach.** Browser / UI peers typically hold only the **session** hub (e.g. SyncDO).
They construct PEW with `kernel: null` (session-only) and get execution reads; catalog is empty
/`unadvertised` unless the host relays orchestration awareness to that peer or the peer also
holds the orchestration doc. Catalog paint for pure-session observers is a **host relay** concern
(name it in `InstallOpts` / SyncDO protocol), not a PEW second book.

### 17.2 Construction — composition, not inheritance

```ts
// claim owner / process that holds orchestration
const pew = new PEW({ kernel: kernelPlexus });

// session-only observer (studio tab, shell peer) — no orchestration doc
const pew = new PEW();
```

- **Not** `class PewPlexus extends Plexus`.
- **Not** a PEW-owned `Map<guid, Plexus>` multi-doc registry.
- **No** `attachSession` / `detachSession` registration API. Sessions are discovered
  automatically when a call needs them.
- `kernel` is **optional**. Catalog getters without it return empty / `plan() → undefined`.
  Session methods take an explicit `session: Plexus` or derive from `E.__doc__`.
- Session reverse-resolve rides existing family APIs:
  - `entity.__doc__` — synced-model document pointer;
  - `docPlexus.get(doc)` — process WeakMap doc → Plexus (same path `parentsOf` uses);
  - `plexus.awareness` — that document's hub.

```text
Expectation E
  → E.__doc__
  → docPlexus.get(doc)     // session Plexus
  → .awareness             // session hub
  → claim scan / report peer
```

PEW may import family internals (`docPlexus`, `__doc__`) as a plexus-family consumer — not a new
public app API.

**Session hub subscription — none to manage.** Observation rides the substrate's ambient
`awareness.reactive` lens (one per hub, disposed with it); PEW carries no subscription or
teardown machinery of its own. Hosts never register or detach sessions.

### 17.3 Wire schema (frozen)

**Orchestration hub — global catalog**

| Field | Content |
|-------|---------|
| `role` | `"catalog"` |
| `loaders` | `Record<planKind, LoaderHealth>` |
| `capabilities` | `Record<planKind, LoaderCapability>` |

No `binds`. No Expectation entity refs.

**Session hub — claim record (orchestrator self-registration)**

| Field | Content |
|-------|---------|
| `role` | `"kernel"` (claim marker) — **required** for discovery |
| `binds` | `Expectation` models (substrate-serialized), same family as the hub |
| `acks` | `{ intentId, state }[]` |

Published under an **arbitrary** regular-range client id (`PlexusAwareness.createLocalClient`),
**not** the hub base `clientID`. See §17.5.

**Session hub — actor**

| Field | Content |
|-------|---------|
| `report` | LWW `TReport` (JSON-serializable) |

One local client per spawn; durable discovery pointer is `Expectation.processorClientId`.
**Client id `0` is banned** for PEW-minted presence clients — plexus reserves / uses `0`
internally (not a PEW-invented "none" semantic layered on a legal id). `newClientId` /
`createLocalClient` used by PEW must never return `0` (remint if needed). Durable field
default `processorClientId = 0` means **unassigned** only because `0` is not a legal PEW
presence client id; inert surface actors leave it unassigned and do not mint a client.
Observers: unassigned / non-minted ⇒ no report; never treat a real minted id as missing.

**Session hub — author**

| Field | Content |
|-------|---------|
| `intents` | `{ intentId, target /* Expectation marker */, body }[]` |

`intentId` remains a string. **`target` is an Expectation model** — never a uuid string field;
the membrane serializes it out and every reader resolves the same live family instance, which is
what lets admission key on instance identity. Retract = remove; reshape = edit body in place (§8).

**Optional loader self-record** (escape hatch, §9):

```ts
{ role: "loader"; kind: string; capability?: LoaderCapability }
```

#### Coherence (substrate law, not reader discipline)

Awareness and doc sync are separate lanes with no cross-lane ordering — and the SUBSTRATE
resolves that, not PEW: an inbound frame whose entity refs the local doc cannot resolve yet is
parked by the awareness coherence gate and released when the doc catches up (last coherent frame
wins; `plexus/docs/awareness-coherence.md`). A frame PEW can read therefore always resolves;
reads hand back the live family instance; deref is strict, and a failed deref anywhere is a bug.
PEW carries **no** tolerance machinery — no try/catch scans, no null-on-missing paths, no
re-evaluation bookkeeping. The one raw read that remains is install-time claim eviction
(`getRawPeer` for `role`), which must not resolve refs it is about to evict.

`isBound(E)` membership compares by **Expectation uuid**; reliable for observers on the same
session doc as the claim record. Cross-session dashboards do not use `isBound`; they use durable
tree state + `processorClientId` / `lastReport`.

### 17.4 Types and public surface

```ts
type LoaderCapability<TArgs = unknown> = {
  status: "ready" | "blocked" | "unavailable";
  door?: string;
  args?: TArgs;
  probedAt?: number;
};

type LoaderHealth = "loading" | "loaded" | `failed:${string}`;

type PlanAvailability = {
  kind: string;
  /** Kernel-catalog health is authoritative when present. */
  health: LoaderHealth | "unadvertised";
  /** Loader self-record capability wins when present; else catalog-probed. */
  capability?: LoaderCapability;
  source: "catalog" | "loader" | "both";
};

/** Claim view after a scan — binds are live family instances (substrate serde). */
type PewClaimRecord = {
  readonly clientId: number;
  readonly binds: readonly Expectation[];
  readonly acks: readonly IntentAck[];
};

type ActorPresenceClient = {
  readonly clientID: number;
  setReport(frame: unknown): void;
  destroy(): void;
};

class PEW {
  constructor(opts?: { kernel?: Plexus | null });

  /** Global catalog face (orchestration hub; empty without kernel). */
  readonly loaders: {
    readonly plans: ReadonlyMap<string, PlanAvailability>;
    plan(kind: string): PlanAvailability | undefined; // undefined = unknown kind
    publish(status: CatalogPresenceStatus): void;
  };

  /** Session execution face — one catalog per session hub. */
  actors(session: Plexus): {
    readonly claims: readonly PewClaimRecord[];
    /** Sole claim after scan; null if zero or dual. */
    readonly claim: PewClaimRecord | null;
    /** >1 claim-marked bases including self. */
    readonly hasDualClaim: boolean;
    /** Author intents on the hub — excludes this catalog's own claim + author pens. */
    readonly intents: readonly IntentRecord[];
    ack(intentId: string): IntentAckState | undefined;
    publishClaim(status: ClaimPresenceStatus): void;
    /** Install under lease — evicts stale claim peers first (§17.5). */
    installClaim(): void;
    /** Overlapping rotation: mint+publish new before destroying old (§17.5). */
    reloadClaim(status: ClaimPresenceStatus): void;
    retireClaim(): void;
    /** Mints one actor client (clientId never 0); caller destroys on reap. */
    mintActorClient(): ActorPresenceClient;
    publishIntents(intents: readonly IntentRecord[]): void;
  };

  /** Per-Expectation face — hub resolved from E.__doc__. */
  of(E: Expectation): {
    readonly report: unknown | undefined;
    readonly isBound: boolean;
    /** Author intents targeting this Expectation. */
    readonly intents: readonly IntentRecord[];
  };
}
```

- **Facets group by hub identity**: `loaders` (orchestration hub), `actors(session)` (a session
  hub), `of(E)` (the hub E's doc resolves to). Aggregates are getters; each facet instance is
  cached per hub / per entity.
- **Work identity = Expectation models** on the wire; intent ids stay strings.
- **`source: "none"` is not used** — unknown kinds return `undefined` from `plan()`.

#### Catalog merge algorithm

Scan orchestration hub for `role: "catalog"` (at most one expected; if several, first found +
host dual-catalog error is out of scope — treat as last-writer LWW on fields) and all
`role: "loader"` records:

| Field | Rule |
|-------|------|
| `health` | Catalog pen is authoritative. Loader self-records do **not** override health. Absent catalog entry → `"unadvertised"`. |
| `capability` | Loader self-record for that `kind` wins if present; else catalog `capabilities[kind]`. |
| `source` | `"catalog"` / `"loader"` / `"both"` according to which sides contributed a non-empty piece. |

Multiple self-loaders for the same `kind`: last-scanned wins (ephemeral; host should not run two).

### 17.5 Claim discovery — arbitrary client id, reload, crash

#### Wire clients PEW owns

PEW owns **at most one wire client per `(hub, role)`** for roles it publishes:

| Role | Hub | Client |
|------|-----|--------|
| catalog | orchestration | one local client (or hub base if host prefers — still scan by `role`) |
| claim (`kernel`) | session | one `createLocalClient` per session hub in use |
| author | session | one client when `publishIntents` is used (distinct from claim, even in-process) |

Repeated `publishClaim` / `publishCatalog` / `publishIntents` **replace fields** on the existing
client — never mint a new client per publish. `retireClaim` / dispose destroy the client (stop
heartbeat). Undestroyed clients after lease yield are a host bug (self-inflicted stale claim).

#### Install under lease (crash-restart)

On **install** while holding the session writer lease, **before** publishing own claim:

1. Scan session hub for all `role: "kernel"` records (raw).
2. **Evict** them via `removeAwarenessStates` (they are dead predecessors or lease bugs; if a
   live rival republishes, dual-claim re-arms correctly).
3. Mint claim client, publish `role` + binds + acks.

This prevents up-to-timeout self-freeze on a reborn lease-holder seeing its own corpse
(`outdatedTimeout` is substrate-default; host may tune if plexus exposes it — PEW states the
evict-on-install rule so it does not depend on timeout).

#### Overlapping reload (ambient runtime update)

**Invariant:** at every instant during a planned reload, **≥1 claim record is live** on the hub.

```text
reload:
  newClient = createLocalClient(hub)
  publish role + binds + acks on newClient
  destroy oldClient          // only after new is visible
```

Sequential destroy-then-mint is **forbidden** — it creates a claim gap that fires runner
self-termination (§6 / §12). Runners still self-terminate on **sustained** claim absence
(host-tuned grace); overlapping reload must finish inside that grace.

#### Discovery is scan, never assume

```text
candidates = all bases on hub (local secondaries + peers + self base if claim-shaped)
  where raw role === "kernel"
hasDualClaim ⇔ candidates.length > 1   // scan INCLUDES self
claim() = sole candidate deserialized (tolerant), else null
```

- Never hardcode hub.clientID as the orchestrator.
- No sticky clientId cache without invalidation on hub `change`.
- **`ack(intentId)`** under dual-claim: undefined / refuse to pick — dual freeze means no
  authoritative claim; do not silently first-scan.

#### Trust model

All presence writers on a session hub are **trusted claim-authority peers** (same boundary as
§8 steering rights = doc access). `role: "kernel"` is a claim of intent, arbitrated by the
**writer lease**; hosts must not feed untrusted peers' presence into PEW / the kernel. Dual-claim
freeze is an advisory tripwire for lease bugs, not multi-tenant isolation.

### 17.6 Reactivity (MobX)

mobx is a hard dependency, but the atom design is the **substrate's**
(`plexus-mobx-awareness`): per-field atoms per base, a membership atom, peer isolation — one
ambient lens per hub. PEW's whole reactivity story is three `@computed` scans over that lens
(`claims`, `intents`, `plans`) plus the per-entity computeds on `of(E)`. Writers never touch
atoms — they write the hub; the lens invalidates.

- `of(E).report` tracks the actor base's `report` field atom; while `processorClientId` is
  unassigned it tracks hub membership, so pre-spawn autoruns re-fire when the actor appears.
  Durable pointer transitions are MobX-visible via the Plexus MobX integration the lens
  registers.
- Frames are opaque LWW replaces — never deep-observe inside `TReport`.
- Peer isolation and catalog isolation (actor report noise must not re-fire `plans`) come from
  the lens's per-field atoms, not from PEW code.
- **No `onChange` API.** Use `reaction` / `autorun`.

Paint:

```ts
observer(function Row({ E, pew }: { E: Expectation; pew: PEW }) {
  const frame = pew.reportOf(E);
  const ready = pew.plan(E.kind)?.capability?.status === "ready";
});
```

### 17.7 Orchestrator integration

```text
const pew = new PEW({ kernel: kernelPlexus });
pew.installClaim(session);           // first use of session hub is automatic; this mints claim

// load / probe → global catalog
pew.publishCatalog({ loaders, capabilities });

// activate E
const client = pew.mintActorClient(session);  // clientId ≠ 0
// on reap: client.destroy(); processorClientId cleared to unassigned (0)
pew.publishClaim(session, { binds: [...table.keys()], acks });

// admission
for (const intent of pew.readIntents(session)) { … tolerant target … }

// dispose lease
pew.retireClaim(session);
// no detachSession — hub destroy / process teardown cleans subscriptions
```

`publishKernelPresence` (single bundled record) is **retired**. Hosts split into
`publishCatalog` + `publishClaim`. Process-local claim table remains the input to
`publishClaim`; the wire is PEW's job.

### 17.8 Import split and migration ledger

| Symbol | Barrel |
|--------|--------|
| `PEW`, `PewClaimRecord`, `PlanAvailability`, `LoaderCapability`, `LoaderHealth`, `PresencePort`, `ActorPresenceClient`, `IntentRecord` | `@here.build/plexus-expectation` (**shared**) |
| `Orchestrator`, `ExpectationActor`, `ExpectationLoader`, settlement / activation | `/executor` only |

**Alignment ledger (2026-08-05):**

| Item | Status |
|------|--------|
| `IntentRecord.target: Expectation` (model, substrate-serialized) | **done** — wire round-trip tested |
| `KernelPresenceStatus` retired → `ClaimPresenceStatus` + `CatalogPresenceStatus` | **done** |
| `claimPresence()` + `catalogPresence()`; PEW publishes the wire | **done** |
| `onClaimPresence` / `onCatalogPresence` host hooks | **done** |
| Admission by model identity on `intent.target` | **done** |
| `Expectation.liveReport(hub)` legacy hub walk | **pending removal** — grace cycle over; use `pew.of(E).report` |
| harness peer-channel uuid binds / `peer.pew` JSON mirror | **pending** — replace with claim scan / `pew.of(E).isBound`; the JSON channel is dual books and its model-typed `intents` field is unpopulatable |

### 17.9 Laws

1. ONE RECORD, ONE WRITER — PEW writers only set fields on the identity they mint or own.
2. No kernel hop on the report path — actor → session hub → `reportOf`.
3. Capability remains advisory forever.
4. PEW never mints presence `clientId === 0` (plexus-internal reservation). Unassigned durable
   pointer is 0 only because 0 is not a legal PEW client id — not a PEW-layer semantic inventing
   "none" over a valid id.
5. Not a second progress mode; not a durable progress mirror.
6. Same-doc entity markers only; catalog never carries session Expectations.
7. Claim ownership is rediscovered by scan (including self); reload is overlapping; install
   under lease evicts stale claim peers.
8. Coherence is the substrate's: frames referencing unsynced entities are unobservable until
   the doc catches up; PEW readers are strict and carry no tolerance machinery.
9. At most one PEW wire client per `(hub, role)`; publish replaces fields; retire destroys.
10. Session hubs are discovered on use — no host attach/detach registration API.

---

## Non-goals

- Domain verbs in the PEW API.
- Multi-generation rebind of one Expectation uuid.
- CRDT-persisted progress, XState snapshots, durable intent state, or durable intent logs.
- Cooperative cancel (typed stub until designed) — including abort-time report flushing (§6).
- Surface-work timeouts/escalation (host policy).
- Imperative presence `onChange` (MobX is the subscription).
- PEW subclass of Plexus or PEW-owned multi-doc registry.
- Session entity refs on the orchestration awareness hub.
- Cross-session `isBound` dashboards (use durable tree + lastReport).
- Treating presence `role: "kernel"` as multi-tenant auth (lease is mutual exclusion; presence is advisory among trusted peers).

## Related

- Package intro: [`../README.md`](../README.md)
- Plexus ownership: `@here.build/plexus`
- Product framing: `harness/docs/architecture/agentic-os.md`
- DO host topology (two-doc): `inhuman/docs/working-proposals/2026-08-03-pew-do-integration.md`
- Eng-reviews: [`reviews/2026-08-03-pew-presence-api-longcat.md`](./reviews/2026-08-03-pew-presence-api-longcat.md),
  [`reviews/2026-08-03-pew-presence-api-fable.md`](./reviews/2026-08-03-pew-presence-api-fable.md)
