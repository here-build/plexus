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
refused  → running | cancelled
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
Actors emit settlement and control outcomes; updates stream straight to awareness with no kernel
hop.

---

## Steering

Declarative and ephemeral: the author writes an intent into their own presence; the kernel admits
it against a live bound execution and mirrors an ack in its presence; the actor observes its
mailbox and reports `considered` | `dropped`. No epochs, no durable rows — retract is removing
the record, reshape is editing it. Admission against a terminal or unbound target is refused;
one-execution guarantees a stale intent can never reach a future execution.

---

## Product extension

Ship a triad: an `Expectation` subclass (declaration fields + `applySettlement`), a
`LaunchDefinition` subclass (durable config), and an actor class. Association is by class;
the string `kind` exists only as the registry key.

```ts
class ToolCallExpectation extends Expectation<ToolResult, ToolReport> {
  static readonly kind = "myapp.tool_call";
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
