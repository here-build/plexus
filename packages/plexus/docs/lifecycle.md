### The Doc-Boundary Law

Reparenting obeys one law: **materialization is contagious**. Whatever is potentially reachable
from a doc is materialized into that doc — in both directions:

- doc-less child + doc-backed parent → the child (and its whole subtree) materializes **down**
  into the parent's doc;
- doc-backed child + doc-less parent → the parent materializes **up** into the child's doc
  (it just became reachable via `child.parent`);
- both doc-less → nothing materializes; both in the same doc → a plain reparent;
- **already materialized in *different* docs → `PlexusDocMismatchError`.** Entities never
  change docs once getting attributed.

The upward direction is what makes **wrap-in-place** legal:

```typescript
// wrap an existing group one level deeper, in place:
root.groups.leaf = new Group({ name: "wrapper", groups: { leaf: root.groups.leaf } });
```

The Right-Hand side evaluates first: the fresh doc-less wrapper adopts the doc-backed child from its
constructor bag — materializing upward and taking ownership of the subtree while itself still
detached — then the assignment re-attaches it one level up. A short, legal frame of doc
detachment; the inner group is the same object throughout (moved, never copied).

## Entity Lifecycle

### Doc-Free Usage

Models can be used without a Y.Doc. Field access, mutation, parent tracking, and all collection operations
work identically — backing storage runs independently; Yjs sync is skipped via null-guards.

```typescript
const page = new Page({ name: "draft" });
page.name = "updated";        // works
project.pages.push(page);     // works, parent tracking works
page.parent;                  // project
```

There's only one exception that requires entity being materialized: **`.uuid`** (throws without doc; see [Identity & UUIDs](#identity--uuids))

> Non-accessible `.uuid` of ephemeral entity is a designed limitation. Plexus model instances are guaranteed to be singletons; for local handling you can use them as map keys directly. For rare edge cases - e.g. in tests - .localID can be used.
> 
> Since all local environment use-cases are covered by instances and `.localID`, `.uuid` only purpose is left as a cross-machine external pointers. Crash on `.uuid` access for entities that are not represented at least in local document guarantees that the entity this `.uuid` points at the entity that will be synced. 

Some introspection behaves differently without a doc:

- `.rootAncestor` → `null` (correct: there is no Plexus root to reach)
- `.isDetached` → `false` (ephemeral entities are not considered detached — detachment is a materialized-entity concept)

Doc-free is a **one-way road**, not a symmetric mode: entities begin doc-free and materialize the
moment they become reachable from a doc (see [The Doc-Boundary Law](#the-doc-boundary-law)); they
never go back.

### Identity & UUIDs

Every model instance has a stable `.uuid`.
UUIDs are **CRDT-native** — they encode the doc guid, client ID,
and logical clock into a single string, enabling **O(1) entity resolution**.

Because they're derived from CRDT state, accessing `.uuid` **throws without a doc**.
This is fine in production (models are materialized), but tests that inspect UUIDs on ephemeral models will crash.

**Deterministic tests.** UUIDs are always CRDT-native — there is no alternative UUID mode. For reproducible identity 
in tests and fixtures, use [`.localID`](#localid--process-local-creation-order-identity): it is minted at construction from one global counter,
exists on doc-less ephemerals (where `.uuid` throws), and `resetLocalIDs()` restarts it at 1 between tests —
fixed creation order gives fixed ids, no env var required.

`.documentId` returns the Y.Doc guid (`undefined` for unmaterialized or dependency entities).

> **Singletons & the ordinal protocol.** Plexus entities are guaranteed singletons — one object per entity, *including across materialization* — so an entity's **pointer identity never changes**. If you need to identify entities **within a session** without a doc-synced UUID (e.g. ephemeral, not-yet-materialized models, whose `.uuid` would throw), use the ordinal keys protocol (`ordinal.id(entity)`) from `@here.build/collections`: a stable, process-local handle keyed off that pointer identity, available *before* materialization.

#### `.localID` — process-local creation-order identity

Every entity also carries a `.localID`: a plain number minted from one global counter, eagerly at
construction. It exists for **every** entity — ephemeral, rehydrated, cloned — before and independent
of materialization, and is **never serialized** (absent from `toJSON()`, the yjs wire state, and every
CRDT document). Because it is minted at construction (never lazily on first access), it is
deterministic under a fixed creation order — the identity to reach for in tests and fixtures.

`resetLocalIDs()` restarts the counter at 1 — a test hook for reproducible ids between tests. Reset
only between tests: entities surviving from before the reset can collide with new ones.

The three identity surfaces, side by side:

| Surface                                                   | Scope                          | Available                             | Use for                                                 |
|-----------------------------------------------------------|--------------------------------|---------------------------------------|---------------------------------------------------------|
| `.uuid`                                                   | doc-synced CRDT identity       | after materialization (throws before) | cross-peer references, storage                          |
| `.localID`                                                | process-local, creation-order  | always (minted at construction)       | test determinism, ephemeral-safe identity, debug labels |
| [`ordinal.id(obj)` ordinal keys (@here.build/collections) | process-local, first-use-order | any object, plexus or not             | identity for arbitrary objects outside plexus           |

`.localID` deliberately mirrors the ordinal protocol but keeps its **own counter domain**: resetting
localIDs must never disturb ordinal ids (which canonicalize live path-map set keys elsewhere in the
process).

### Status

```typescript
entity.isRoot;      // true if this is the document root entity
entity.isDetached;  // true if materialized but not reachable from root
```

### Operations

```typescript
entity.detach();                             // remove from parent, returns true if was attached. Still present in doc
entity.clone({ title: "Copy" });             // deep clone of child subtree with optional overrides
entity.toJSON();                             // plain object of all schema fields
```

> **Deep Sub-Tree Cloning**: `.clone()` copies the **owned** subtree — children recurse, fresh
identity everywhere (new UUIDs, new CRDT nodes), structure preserved. Non-owning refs follow the
closure-conversion rule: a ref **rebinds** iff its target is inside the same top-level clone;
otherwise it is **preserved** verbatim (free variables stay free). This is the only globally
consistent rule. If a call site needs a free ref rebound, compose there: clone the owner that
owns both (the mapping rebinds automatically), pass a prop override
(`entity.clone({ ref: newTarget })`), or plainly assign after cloning (refs don't own —
assignment never steals).

Note that cloning and detaching is not decoupling the entities from the original doc.
Avoid cross-doc movement of cloned entites.

> Detached node may still be present in non-child fields and structs;
> and `.clone()` may return non-parented fields with other doc-materialized entities.
> Despite being ephemeral (local) itself, when trying to materialize, 
> materialization those non-owned fields will be still attempted, leading to crash.
> Feeding refs harvested from a clone into an owning field of a
> fresh entity is an **adoption**: within one doc it is legal and **moves** the original
> (the fresh owner materializes upward — wrap-in-place contagion), so if you meant "copy" you just
> stole the source's children; across docs it throws `PlexusDocMismatchError`. "Harvested from a
> clone" ≠ "safe to own". Full derivation: [`src/clone.ts`](../src/clone.ts) header.

**Native Snapshotting**: Because Plexus cleanly manages JavaScript object internals without hiding them behind opaque wrappers,
native JS utilities work flawlessly straight out of the box.
You don't need a special "snapshot protocol" for UI serialization — spread syntax (`{...entity}`),
`structuredClone(entity)`, and `JSON.stringify(entity)` natively extract everything you expect without crashing on CRDT symbols.
