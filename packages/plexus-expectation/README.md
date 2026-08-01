# PEW — Plexus Expectation Workflow

**Durable progressive invocations on Plexus.**

Package: `@here.build/plexus-expectation`

PEW is the invocation substrate for systems that need work to **outlive a process**,
**expose intermediate progress**, **suspend and resume under a claim owner**, and
**supervise nested work as one tree** — without inventing four parallel mechanisms.

In the agentic OS framing (harness), PEW is ring-0 control of work. Bodies (ACP,
tools, surfaces) live outside; the Expectation is what the kernel *is* about work.

---

## The unit: Expectation

An **Expectation** is one **actor invocation** made durable and observable.

It is not “a job row,” not “a promise wrapper,” not “a session object.” It is a
**single object that is four familiar things at once**:

| Face | What you get | Familiar API feeling |
|------|----------------|----------------------|
| **Promise** | Eventually settles into exactly one terminal | `await` / `.then` / final success·failure·cancel |
| **Async generator** | Yields structure *while still open* | intermediate steps, partials, nested `yield*` |
| **Actor FSM** | Discrete lifecycle with illegal transitions refused | states, events, no revive from terminal |
| **Continuation (call/cc-shaped)** | Work suspends and resumes under a claim owner | rebind after host death without a second stack |

The novelty is not any one face — libraries already cover each. The novelty is that
**one durable entity is the settlement point, the progress surface, the state machine,
and the reified continuation**, with **children as nested yields under the same
supervision law**.

```text
                    ┌─────────────────────────────────────┐
                    │           Expectation               │
                    │  (one progressive durable invoke)   │
                    └─────────────────────────────────────┘
                      │           │            │         │
              settle  │    yield  │     state  │  resume │
                      ▼           ▼            ▼         ▼
                  Promise    Async gen      Actor FSM   Continuation
                  (final)    (progress +     (lifecycle) (claim +
                              children)                   rebind)
```

### Promise — “it will end”

Open work must complete. Terminals are **final**:

| Terminal | Meaning |
|----------|---------|
| `sealed` | Succeeded; product payload holds the result |
| `failed` | Failed; product payload holds the reason |
| `cancelled` | Aborted (tree cancel or host cancel) |

From a terminal, **no lifecycle transition leaves** — same-state writes are no-ops
(idempotent dual-write friendly); any other write throws.

Callers that only care about “when is this done?” treat the Expectation as a
future. Callers that care about *how* it got there use the other faces.

### Async generator — “here is what I’m doing”

While open, the Expectation exposes **progress without settling** on **awareness**
(not CRDT). Law: **one awareness base clientId ↔ one Expectation**.

```ts
// Hub = session doc awareness (plexus.awareness or test hub on same Y.Doc)
Expectation.bindProgressHub(hub);

// Claim owner on activate (orchestrator does this):
E.attachLivePresence();           // mints client; sets E.processorClientId
E.reportProgress({ tokens: "…" }); // writes field `progress` on *that* client
E.progress;                         // local client, or peer via processorClientId
E.clearProgress();                  // destroy client + clear pointer (settle/rebind)
```

- **No Progress entity** — same Expectation; live half is its own awareness client.
- **No multi-E map on one client** — if a process runs two Es, it mints two clients.
- **No test-only plane** — tests use ephemeral `Y.Doc` + `PlexusAwareness` like plexus.
- **Children** — nested work is still CRDT `children`; each child gets its own client.

So a completion that needs a tool call does not invent a side channel. It
**spawns a child Expectation**. Parent stays open; child runs, settles; parent
continues or fails. Live stream text is `E.progress` (or the child’s), not a
durable field.

### Where result and history live

| Concern | Home |
|---------|------|
| Sealed / failed payload | **On the Expectation** (product fields) |
| In-motion yields | **Awareness client** for that E |
| Executor reconnect / debug log | **Claim-owner or module-local** — not a global OS residual |
| Global multi-actor “session journal” | **Optional backup** only; not PEW’s progressive SSoT |

Hosts that still fold a global event tape for streaming are on a **transitional** path.
New work should settle payloads on `E` and stream via `E.progress`.

### Actor FSM — “which control states are legal”

Durable lifecycle (XState graph; only legal edges):

```text
declared ──► missing | refused | running | cancelled
missing  ──► running | refused | cancelled
refused  ──► running | cancelled
running  ──► awaiting_rebind | sealed | failed | cancelled
awaiting_rebind ──► running | sealed | failed | cancelled
sealed | failed | cancelled  = final
```

Named writers (`transitionState`, `beginRunning`, `enterAwaitingRebind`,
`trySettleFromRunning`, `cancelSubtreeDurable`) refuse illegal edges. The machine
is not decorative — short-circuits like `declared → sealed` are **structurally
impossible**.

Process-local activation (`binding` / `activating` maps) is **not** this enum.
Claim ownership is runtime; lifecycle is durable.

### Continuation — “the stack lives here”

When the process that was resolving the Expectation dies:

1. Abort is claim-owner responsibility (process-local handles).
2. Durable state can move to `awaiting_rebind` (with optional `rebindCount`).
3. A new claim owner **re-enters** the same Expectation — same uuid, same tree,
   bumped `bindEpoch` on `beginRunning`.

That is call/cc-shaped: the **reified control point is the entity**, not a
thread-local stack frame. The body re-attaches; the debt does not mint a second
identity.

`bindEpoch` makes late settlements from a previous resolver race-safe
(`trySettleFromRunning(terminal, expectedEpoch)`).

---

## Why four-in-one (and not four types)

Agentic work fails when these split:

| Split | Failure mode |
|-------|----------------|
| Promise only (job queue) | No progressive structure; UI and nested tools invent side channels |
| Generator only (streams) | No durable identity after crash; no supervision tree |
| FSM only (session phase) | Progress and result live elsewhere; dual books |
| Continuation only (checkpoints) | No shared vocabulary for “open work” across products |

PEW’s bet: **resilience is the composition**. Cancel is tree law. Handover is rebind.
UI watches one object. Product kinds only specialize **payload**, not the control
contract.

---

## What an Expectation is *not*

| Not this | Why |
|----------|-----|
| A transport (ACP, HTTP) | Transport is **inside** the actor body (claim-owner module) |
| A session / conversation | Session is host projection over a **forest** of Expectations |
| A journal event | Journal is past-tense facts; Expectation is **open obligation** |
| A Program (map/reduce) | Programs extend *policy language* (eBNF-shaped); Expectations are *work* |
| Four separate CRDT fields for status/result/progress/children | One entity, four faces |

---

## Tree law (structured concurrency, durable)

```text
Parent (e.g. completion)
  ├── child (tool_call)
  ├── child (approval)
  └── …
```

- `children` is owned (`@syncing.child.list`)
- `cancelSubtreeDurable()` walks **children first**, then self → `cancelled`
- Host must **abort resolvers** before durable cancel (abort-before-cancel)
- Open work forests hang off product roots (e.g. session `openWork`); PEW does not
  invent a global process table

This is structured concurrency with a CRDT mailbox: the nursery survives the VM.

---

## Plan + claim (BEAM-shaped, not full BEAM)

| Piece | Role |
|-------|------|
| **Kind** | Product discriminator (`static kind` on subclass) |
| **LaunchDefinition** | Abstract self-contained strategy (`InProcess` / `Surface` / product subclasses) |
| **Orchestration** | Kind → plan registry (empty by default; product fills) |
| **Claim owner** | Exactly one process may resolve a running Expectation |
| **Resolver** | Body that progresses and settles under the claim |

OTP analogy: Expectation ≈ process; tree ≈ supervision; claim owner ≈ scheduler
node. Difference: OTP processes die with the VM; Expectations **persist** and
**rebind**.

Import split:

| Import | Who |
|--------|-----|
| `@here.build/plexus-expectation` (default) | **App** — entities, lifecycle, plans (any process that holds the doc) |
| `@here.build/plexus-expectation/runtime` | **Claim owner only** — activate, settle, cancel, rebind |

Default barrel is app-only so UI replicas cannot accidentally pull orchestrator
APIs.

---

## Control plane (three flows)

PEW is an **opaque substrate** (same discipline as Plexus): no domain verbs
(`steer`, `retry`, tool/turn names) in the core API.

| Flow | Role |
|------|------|
| **Expectation** | Work continuation with progression (four faces above) |
| **Cancellation** | System stop — `requestCancellation` **invokes** existing `cancelTree` physics; does **not** replace interrupt/orphan/parent writers (C1) |
| **ExpectationAdjustmentIntent → ExpectationAdjustment** | Simplex treatment **beacon**: author mints `intentId` for presence/tracking; materialize auto-assigns CRDT `uuid` and stores `intentId` for correlation (C3). **No reply channel** — consumption acks only; PEW never writes the target Expectation from `markConsidered` (C2) |

```ts
// Cancellation (claim owner)
orch.requestCancellation(E, { strength: "immediate", reason: "user" });
// same as cancelTree for immediate; cooperative is typed stub for later

// Adjustment (simplex)
const intent = {
  type: "expectationAdjustment" as const,
  intentId: crypto.randomUUID(), // author-minted — not Plexus uuid
  targetUuid: E.uuid,
  reshapeEpoch: 0,
  body: opaqueActorDomainPayload,
};
const { adjustment } = orch.materializeAdjustment(intent, bag);
orch.deliverAdjustment(E, adjustment);
// resolver may ackWillConsider / markConsidered / ackDropped via control callback
```

Design: `docs/working-proposals/2026-08-01-pew-intent-obligations.md`

---

## Domains

```text
app/            Expectation, Adjustment, control shapes, lifecycle machines
orchestration/  Orchestration, LaunchDefinition
runtime/        Orchestrator, resolvers — claim-owner process
```

Product packages (e.g. harness-model) **subclass** Expectation with kind-specific
payload fields and register LaunchDefinitions. PEW stays plane-agnostic: it does
not know “LLM” or “bash.”

---

## Minimal mental API

```ts
// Product subclass (kind + payload)
class ToolCallExpectation extends Expectation {
  static readonly kind = "myapp.tool_call";
  @syncing accessor name = "";
  @syncing accessor argsJson = "{}";
  @syncing accessor outcomeJson = "";
}

// Bind hub once per process (claim owner + UI readers)
Expectation.bindProgressHub(sessionAwareness);

// Lifecycle (promise + FSM) + live client (orchestrator attaches on activate)
E.beginRunning();
E.attachLivePresence();              // one awareness clientId for this E
E.trySettleFromRunning("sealed");
E.cancelSubtreeDurable();

// Progress (generator face) — that client's `progress` field
E.reportProgress({ partial: "…" });
E.progress;                          // local client or peer via processorClientId
E.clearProgress();                   // destroy client (seal / cancel / rebind)

// Nested work
E.children.push(childExpectation);

// Continuation
E.enterAwaitingRebind(true);
// later, new claim owner:
E.beginRunning();
E.attachLivePresence();              // new clientId under rebind
```

Illegal transitions throw `PewTerminalWriteError`. Same-state is a no-op.

**Progress laws:** never `@syncing`; default coalesce `lww`; `append` is size-capped;
no plane → `progress` undefined / report no-op; plan `emitsProgress: false` or
`progressMode: "none"` skips orchestrator writes.

---

## Journal vs PEW

| | PEW Expectation | Journal |
|--|-----------------|---------|
| Tense | Open obligation + progressive control | Past-tense facts |
| Crash | Rebind / settle race via epoch | Replay folds |
| Nested work | Child Expectations | Optional create-side mirrors |
| Authority for “is this still owed?” | **Expectation tree** | Must not be a second lifecycle |

Dual-write (journal *and* PEW for the same unit) is a transitional scar when a host
still has fold-based turn books. Direction of travel: **PEW is SSoT for open work**;
journal remains observability and admission history.

---

## Related

- Agentic OS canon: `harness/docs/architecture/agentic-os.md`
- Substrates (journal / plane / awareness): `harness/docs/specs/substrates-and-actors.md`
- Plexus ownership + field defaults: `@here.build/plexus`

---

## License

[Functional Source License, Version 1.1, MIT Future License](../../LICENSE.md).
