# PEW — Plexus Expectation Workflow

**Package:** `@here.build/plexus-expectation`

Durable progressive invocations on Plexus. One noun for open work: **Expectation**. One
claim-owner kernel resolves them; actors report simplex; steering is declarative presence data.

Full architecture (planes, triads, channels, end paths): **[`docs/design.md`](./docs/design.md)**.

---

## Exports

| Import | Who | Contents |
|--------|-----|----------|
| `@here.build/plexus-expectation` | Any process holding the doc | `Expectation`, `LaunchDefinition`, `Orchestration`, lifecycle machine, intent types, **`PEW`** presence lens (design.md §17) |
| `@here.build/plexus-expectation/executor` | Claim owner only | kernel (`Orchestrator`), `ExpectationLoader`, `ExpectationActor`, activate / settle / cancel |

Observers must not import `/executor`.

**Presence:** `new PEW({ kernel? })` — optional orchestration hub for global loader catalog;
session hubs discovered automatically via `entity.__doc__` / session args (no attach API).
Claim rediscovery under arbitrary client id (never 0); overlapping reload. MobX-reactive
reads; model keys, not uuids. Full contract: design.md §17.

---

## Unit: Expectation

One durable entity is at once:

| Face | Meaning |
|------|---------|
| **Promise** | Settles to exactly one terminal: `sealed` \| `failed` \| `cancelled` |
| **Generator** | Live state via the actor's awareness record; final frame folded durably at terminal |
| **FSM** | Discrete lifecycle; illegal writes throw; end-trigger races no-op |
| **Continuation** | One execution per entity — death ends this E; retry mints a new one |

```text
declared → missing | refused | running | cancelled
missing  → running | refused | cancelled
refused  → missing | running | cancelled
running  → sealed | failed | cancelled
terminals are final
```

Every terminal carries `endCause` (`settled` | `surface` | `cancel` | `supervision` | `crash`)
and `lastReportJson` — a finished, failed, or cancelled unit always renders its last known state.

Nested work is `E.children` (owned list). Cancel is tree-shaped: abort actors first, then durable
cancel, children before parent.

---

## Three planes, one writer each

```text
durable    Expectation tree + plan registry     host authors the birth; kernel writes everything after
awareness  actor updates · intents · kernel status · loader capability     each participant, own record only
process    kernel table · loaders · actor handles     claim owner's memory
```

The kernel never calls into an actor — the AbortSignal is the only kernel-initiated signal.
Actors emit reports and settlement; updates stream straight to awareness with no kernel hop.

---

## Steering

Declarative and ephemeral: the author calls `pew.request(target, intent)` — the intent lands in
their own presence; the kernel's only responsibility is mirroring standing intents into the bound
actor's inbox each sweep. What the actor does with its inbox is its own decision — there are no
acks; the durable plane is the acknowledgment. No epochs, no durable rows — retract is removing
the record, reshape is editing it; a terminal or unbound target is simply never mirrored, and
one-execution guarantees a stale intent can never reach a future execution.
`pew.requestCancellation(target)` is the universal envelope verb — kernel-handled, never the
actor's inbox, and reaches declared (unlaunched) work too.

---

## Product extension

Ship a triad: an `Expectation` subclass (declaration fields + `applySettlement`), a
`LaunchDefinition` subclass (durable config), and an actor class. Association is by class;
`kind` IS the `@syncing` registry tag — derived, never declared.

```ts
@syncing("myapp:tool_call")
class ToolCallExpectation extends Expectation<ToolResult, ToolReport> {
  @syncing accessor name = "";
  @syncing accessor argsJson = "{}";

  applySettlement(result: ToolResult): void { /* typed product-field writes */ }
}
```

---

## Related

- Design: [`docs/design.md`](./docs/design.md)
- Agentic OS (product framing): `harness/docs/architecture/agentic-os.md`
- Plexus: `@here.build/plexus`

## License

[Functional Source License, Version 1.1, MIT Future License](../../LICENSE.md).
