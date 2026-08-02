# PEW design

**Package:** `@here.build/plexus-expectation`
**Status:** contract — the implementation is being aligned to this document; where code and doc disagree, the doc wins.
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
refused  ──► running | cancelled
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
  readonly log?: LogPort;            // host-provided sink (endpoint or fs path) — §8 audit
};

type ActorHandle = {
  readonly settled: Promise<Settlement<unknown>>;
  readonly clientId: number;              // awareness client on the session hub; 0 = no presence
  settlement(): Settlement<unknown> | null; // sync buffer, set at emit — folds consult it first
  lastReport(): unknown | null;             // kernel-side frame buffer — §6
  onControlOutcome(sink: (o: IntentOutcome) => void): void;
};
```

Port contracts (one line each): `PresencePort` mints at most one awareness client per spawn, on
the session hub; `MailboxView` is a read-only observable list whose entries the kernel adds and
removes; `LogPort` is an opaque append sink the core never reads back.

---

## 6. Progress and the last-report law

The actor base class owns the whole updates pipeline:

- It mints its own awareness client at spawn through `ctx.presence`. The client always lives on
  the **session hub** (cross-process runners relay through their adapter onto the session hub),
  so `clientId` is hub-unique and the durable discovery pointer is unambiguous. `clientId = 0`
  is the "no presence" sentinel (inert surface actors) — observers must treat 0 as *none*, never
  resolve it.
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
admission rule: an intent targets an Expectation **uuid**, admission requires that uuid to be
**locally bound right now**, and one-execution guarantees a uuid never runs again. A stale
"retry now" surviving in an author's presence is refused against a terminal or unbound target;
there is no execution it could ever reach except the one it was written for.

Protocol (each arrow is a presence write in the writer's OWN record, or a process-local flow):

```text
author presence:  intents: [{ intentId, targetUuid, body }]
                       │  (kernel observes)
kernel admission: target open + locally bound + definition.acceptsMessages
                  + intentId not already live      → admitted | refused:<code>
kernel presence:  acks: [{ intentId, state: admitted | refused:<code> | considered | dropped }]
                       │  (mailbox view updates)
actor:            observes mailbox at its own pace → emits considered | dropped
kernel:           folds outcome into its ack record
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
- Intents targeting a terminal or unbound Expectation are refused at admission. Admitted intents
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

**Audit is the actor's job, not the model's.** There is no durable intent log in the core: a
synced log is a permanent CRDT commitment with no core consumer, and steering history is
execution history — it belongs where the execution's other artifacts live. The kernel passes a
host-provided `LogPort` (endpoint or fs path) in `LaunchContext`; loaders and actors that want an
audit trail write to it.

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
- **Loader health lives in the kernel's presence.** The kernel advertises, per registered plan:
  loaded (with the loader's own presence `clientId` when it has one), loading, or
  `failed:<reason>`. A failed `load()` leaves the Expectation in its open state, visible against
  the failure record; the kernel re-attempts on plan change or explicit host re-bootstrap, never
  in a hot loop.
- **Capability is the loader's own presence.** A loader that wants eager loading or wants to
  advertise capability (a local model server listing its models) publishes its own presence
  record; the kernel observes it like everything else. Lazy loading on first spawn is the
  default.
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

The claim owner periodically (and on model/presence reactions):

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
- The kernel advertises its binds, loader health, and claim-ownership in its own presence record.
  Presence-based dual-claim detection is **advisory** — a tripwire for lease bugs, not the mutual
  exclusion itself: two live claim-owner peers freeze activation on both sides and surface a host
  error until one yields. During such a window, durable writes from both peers land as CRDT LWW —
  PEW bounds the damage (freeze) but cannot arbitrate it; the lease layer must.
- **Liveness windows are host policy.** Presence timeouts (claim-orphan detection, runner
  self-termination grace) are host-tuned constants; PEW states their consequences, not their
  values.
- **Accepted-loss ledger** (each entry: the alternative is a second durable writer, which costs
  more than the loss):
  - A network partition can orphan-fail work whose actor is alive on the far side; its late
    settlement folds as a no-op. Retry is a new Expectation.
  - A cross-process frame or settlement published but not yet relayed when the runner dies is
    lost.
  - A mis-tuned liveness window can self-terminate a healthy runner (false presence loss) or
    orphan-fail work under a GC-paused kernel.

---

## 13. Journal relationship

| | PEW | Journal (host) |
|--|-----|----------------|
| Open-work authority | Expectation tree | not a second lifecycle |
| Progress | awareness | optional debug mirror |
| Terminals | Expectation state + `endCause` + product fields + last report | optional observability |

Hosts may dual-write during migration (the journal is the host's own record — §2 scope); product
truth for "is this still owed?" is PEW.

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
| Intent admission | refused on: terminal target, unbound target, duplicate live intentId, `acceptsMessages: false` |
| No-epoch reshape | in-place body edit visible in mailbox; outcome folds by intentId regardless of revision |
| Dual-claim freeze | fabricated claim-owner peer presence freezes activation both ways (existing pattern) |
| Loader health | failing `load()` appears in kernel presence, work stays open, no hot loop; `missing`/`refused` move onward when definition/loader registered |

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

---

## Non-goals

- Domain verbs in the PEW API.
- Multi-generation rebind of one Expectation uuid.
- CRDT-persisted progress, XState snapshots, durable intent state, or durable intent logs.
- Cooperative cancel (typed stub until designed) — including abort-time report flushing (§6).
- Surface-work timeouts/escalation (host policy).

## Related

- Package intro: [`../README.md`](../README.md)
- Plexus ownership: `@here.build/plexus`
- Product framing: `harness/docs/architecture/agentic-os.md`
