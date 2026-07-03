# Virtual Maps — deterministic genesis

> ⚠️ **Advanced.** Virtual deterministic genesis entities are solving a very niche problem.
> Unless you encounter that kind of CRDT conflicts explicitly, you likely do not need it.  
> Use only when you specifically need conflict-free concurrent spawn of equivalent entities.
>
> It is **NOT** intended to be a general lazy-load solution.

`@syncing.virtual(factory)` is a conflict-on-spawn resolution mechanism.
The entity pretends all children exist simultaneously and spawns them on-demand via a factory:

```typescript
@syncing.virtual((key: string) => new Config({ key }))
accessor configs!: VirtualMap<string, Config>;

// Accessing a key spawns the entity deterministically.
// It appears on first access in a conflict-free, deterministic manner.
const cfg = root.configs.get("theme");
```

When multiple users create identical nodes, they are still considered as different entities by CRDT runtime.
If there is a certainty on fully deterministic state at initialization time - for example,
just "empty pointer" node – it may be defined in virtual genesis flow.

It means that the special virtual "user" appears in CRDT for everyone accessing this field,
generates this entity in a way that will be identical for every user out there,
and during the CRDT merge, it will not overwrite itself, but merge safely.

> **Constraints:**
>
> - **Document-bound:** `.get()` requires the owner to be connected to a `Y.Doc`.
> Ephemeral (doc-less) models must not access virtual fields — it will throw.
> Use eager construction (`constructor` + `@syncing.child.map`) for fields that must work in both ephemeral and connected contexts.
> - **Factory isolation:** Factory runs in a sandbox with no access to external models.
> Only entities created within the factory are accessible.
> - **Mutations blocked:** `.set()`, `.delete()`, `.clear()`, `.assign()` all throw at runtime.
> Virtual children are created by the factory, not by callers.
> - **Keys:** Primitives, primitive arrays, and `PlexusModel` instances (when connected to a doc) are valid keys.
> Sets are rejected. Disconnected PlexusModel keys throw.
> - **Clone:** Virtual children are skipped during clone — they auto-materialize on access in the clone.
> - **Undo:** Genesis operations use `GENESIS_ORIGIN` — invisible to UndoManager.
> - This is **not** a general-purpose lazy loader.

Full mechanism: [src/virtual-children-genesis.ts](../src/virtual-children-genesis.ts).
