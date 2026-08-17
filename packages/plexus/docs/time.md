## Reactivity

Reactivity is MobX. Field reads inside `autorun` / `reaction` / `@computed` track; writes invalidate. There is no register step.

```typescript
import { autorun } from "mobx";

autorun(() => {
  console.log(`${project.title}: ${project.members.length} members`);
});

project.title = "Updated"; // Triggers reaction
```

Plexus applies **highly granular Map and Set tracking**.
It tracks structural access dynamically — calling `map.has("key")` or checking `set.size` binds observers exactly
to those specific structural traits rather than the whole collection. An update to the value of `'another-key'`
will not trigger a re-render for a component purely observing `.has('key')` or `.size`.

### MobX Reaction Tracking

```typescript
import { reaction } from "mobx";

const dispose = reaction(
  () => [project.title, project.members.length],
  () => console.log("Changed!")
);
// dispose() when no longer needed
```

## Transactions

### Syncing Action (`@syncing.action`)

`@syncing.action` is a high-level decorator that wraps auto-detected document transactions and `mobx.action`,
spawning **one transaction per doc it touches**:

```typescript
@syncing("Board")
class Board extends PlexusModel {
  @syncing accessor count!: number;
  @syncing.child.set accessor bars!: Set<Bar>;

  @syncing.action
  doStuff() {
    this.count = 1;
    this.bars.add(new Bar({ label: "new" })); // materializes a new entity mid-method
    this.count = 2;
    // all deferred — replayed as exactly ONE flush at method return
  }
}
```

For each doc the body mutates, the action guarantees **one YJS transaction** (one `update` event,
delivered whole to peers), **one undo unit**, and all-or-nothing visibility of that update.

Syncing Action is following the same contagious logic the materialization has - you can invoke action method
on ephemeral (local) entity, and the moment it touches the document, the document transaction starts.

### Action Crash Behavior

By default, a throw is **commit-on-crash**: writes buffered before the throw still flush, then the
error rethrows — matching both hosts (JS never unwinds statements that already ran; YJS never
rolls back). This is the default JS and YJS behavior preserved. Yet, rollback logic can be introduced:

```typescript
@syncing.action({ rollbackIf: (e) => e instanceof PlexusCycleError })
risky() { /* ... */ } // a matching throw discards the batch — nothing hits the wire
```

A rolled-back action it not undo - it broadcasts **nothing**, even when the body spans multiple docs.
See `src/action.ts` for the full mechanism and edge cases.

**Boundaries.** The envelope has documented edges with clean reasons:

- **Doc-less (ephemeral) receiver** — with no doc there is nothing to batch into: every write
  lands eagerly, exactly as it would outside the action; no transaction, no undo unit, no
  rollback (`rollbackIf` has nothing to discard), and no warning. Materialize the receiver
  first if you need the guarantees.
- **Async / generator bodies are a compile error** — the region is synchronous and flushes at
  return, so a body that suspends (`async`) or runs lazily (generators) cannot be batched. The
  ban is enforced at the input type; if it is bypassed (a cast, `any`, plain JS), the decorator
  still warns once per method: at decoration time for declared shapes (`async`, `function*`,
  `async function*`), at runtime when a body returns a thenable — returning a
  synchronously-built promise is legal, but writes in its continuations land outside the region.
- **Called inside `plexus.transact()`** — the action cannot own its transaction boundaries and
  warns once; call actions outside `transact()` (the action IS the batch).

### Direct transaction control

`Plexus` class instance provide low-level API to wrap the doc-specific transactions.

Batch changes into a single sync + reactivity event:

```typescript
plexus.transact(() => {
  project.title = "New Title";
  project.members.push(user1, user2);
  project.metadata.status = "active";
});
```

Transactions form **safe shadow sub-transactions**. If function A initiates a `plexus.transact()`
and inside it invokes function B (which also wraps itself in `plexus.transact()`),
Plexus handles it by no-oping the inner boundary.
You can wrap any granular helper mutation in a transaction without worrying about breaking batching when composing functions together.

> MobX `action()` and `plexus.transact()` are separate — if mixing reactive systems, use both.

## Undo / Redo

```typescript
plexus.undo();
plexus.redo();
```

Always use these wrappers — not the raw Yjs `UndoManager`.
The wrappers set an internal tracking state so that operations triggered during undo/redo
(observation re-bootstrap, parent pointer fixup) are not themselves recorded as undoable actions.
Built on `UndoManager` internally with a 500ms capture window.

Structural operations (entity creation, container materialization) are automatically excluded from the undo history —
only content changes are reversible.
