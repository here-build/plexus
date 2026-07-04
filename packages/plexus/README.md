# @here.build/plexus

![i-cant-believe-its-not-local.png](i-cant-believe-its-not-local.png)

Reactive state management with automatic replication in familiar style.
Just make TypeScript classes sync across clients via most popular JS CRDT protocol.

```bash
npm install @here.build/plexus
```

## Who this is for

You're building a real-time collaborative app, you've found Yjs (or Automerge, or Liveblocks),
and you're trying to figure out how to keep your domain model and your CRDT state in sync
without writing 500 lines of glue code per entity. **Plexus is the layer that makes your TypeScript classes the CRDT.**
Decorate fields with `@syncing`, get reactive replication, MobX integration, parents-of/children-of traversal,
and append-only entity shells with native undo/redo, while keeping close to zero overhead over native Yjs structs.
Yjs-compatible underneath; works with any Yjs provider you already trust.
Rides MobX reactivity stack opt-in - both local and remote changes will trigger `observer()`, `reaction()` and `autorun()`.

If you'd rather build collaboration with classes than with `Y.Map.set("key", value)`, this is for you.

## Contents

- [Who this is for](#who-this-is-for)
- [Quick Start](#quick-start)
- [Defining Models](#defining-models)
  - [Primitive Fields](#primitive-fields)
  - [Collection Fields](#collection-fields)
  - [Child Fields (Ownership)](#child-fields-ownership)
  - [The Doc-Boundary Law](#the-doc-boundary-law)
  - [Virtual Maps](#virtual-maps)
  - [Map Keys](#map-keys)
- [Constructor Patterns](#constructor-patterns)
- [Inheritance](#inheritance)
- [Entity Lifecycle](#entity-lifecycle)
  - [Doc-Free Usage](#doc-free-usage)
  - [Identity & UUIDs](#identity--uuids)
  - [Navigation](#navigation)
  - [Status](#status)
  - [Operations](#operations)
- [Reactivity](#reactivity)
- [Transactions](#transactions)
- [Undo / Redo](#undo--redo)
- [Liminality (Ephemeral Gestures)](#liminality-ephemeral-gestures)
- [Awareness (Presence)](#awareness-presence)
- [Querying](#querying)
- [Tree Walking](#tree-walking)
- [Cross-Document Dependencies](#cross-document-dependencies)
- [Telemetry](#telemetry)
- [Error Types](#error-types)
- [API Reference](#api-reference)
- [License](#license)

## Quick Start

> You will need to use **TypeScript** with **stage-3 decorators** specifically.
> Make sure that `experimentalDecorators` in `tsconfig.json` is **disabled**.

```typescript
import * as Y from "yjs";
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

// you will need only three entities - @syncing.* to annotate... 
@syncing
//  ...PlexusModel to extend from...
class Counter extends PlexusModel {
  @syncing accessor count = 0;
}
//  ...and Plexus to connect the document to the model.
const plexus = Plexus.bootstrap(new Counter());
//  And it's just synced to all connected clients
plexus.root.count++;
```

Connect any Yjsprovider — [y-websocket](https://github.com/yjs/y-websocket), [y-webrtc](https://github.com/yjs/y-webrtc), [Hocuspocus](https://hocuspocus.dev), [PartyKit](https://partykit.io), [Liveblocks](https://liveblocks.io), [y-sweet](https://github.com/jamsocket/y-sweet) —
for real-time sync:

```typescript
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
await provider.synced;
Plexus.connect(doc);
```

## Defining Models

### Primitive Fields

```typescript

@syncing
class Project extends PlexusModel {
  // note that you only can use accessors, not values - TS will prohibit non-accessor declarations
  @syncing accessor title: string = "";
  @syncing accessor owner: User | null = null;
  @syncing accessor createdAt: Date = new Date();

  // Computed properties work as expected. It's just JS.
  get titleUpperCase() {
    return this.title.toUpperCase();
  }
}
```

**Supported value types:** `string`, `number` (including `Infinity`, `-Infinity`, `NaN`), `boolean`, `null`, `bigint`, `Date`,
`Uint8Array`, and `PlexusModel` references.

Note that `undefined` is not supported and will be coerced to `null`.

> Why? It is impossible to properly track the constructor finishing its job without breaking lots of things.
> It means that we cannot track the default value assignment. 
> 
> As a consequence, it means that we cannot differ default value assignment in constructor and post-constructor assignment;
> saying "undefined means absence of value,
> null means empty value" lets us solve several edge cases around default value vs value intentionally passed in constructor. 

### Collection Fields

```typescript

@syncing
class Project extends PlexusModel {
  @syncing.list accessor members: User[]; // you may skip struct declarations
  @syncing.set accessor tags: Set<string> = new Set(["default-tag"]); // or declare defaults explicitly 
  @syncing.record accessor metadata: Record<string, string>;
  @syncing.map accessor scores: Map<User, number>;
}
```

**In-place Mutative Diffing**: Plexus performs diffing under the hood when you overwrite a collection.
Reassigning a collection field (e.g. `project.tags = new Set(["a", "b"])`) does not create a new CRDT node and destroy the old one.
Instead, it intelligently performs a granular diff (`add`/`delete` operations) against the existing CRDT node,
maintaining the underlying struct identity and preserving observers flawlessly.

### Child Fields (Ownership)

Use `.child` decorators for parent-child relationships with automatic reparenting.
Child fields confer ownership — a child can only have one parent at a time.

```typescript

@syncing
class Project extends PlexusModel<null> {
  @syncing.child.list accessor pages: Page[];
  @syncing.child.set accessor components: Set<Component>;
  @syncing.child.record accessor configs: Record<string, Config>;
  @syncing.child.map accessor assignments: Map<string, Task>;
  @syncing.child accessor activePage: Page | null = null;
}

// PlexusModel<Parent> types the .parent accessor
@syncing
class Page extends PlexusModel<Project> {
  @syncing accessor name: string = "";
}
```

Moving a child to a new parent **automatically removes it from the old one**:

```typescript
const page = new Page({ name: "homepage" });
project1.pages.push(page);    // page.parent === project1
project2.pages.push(page);    // page.parent === project2, project1.pages is empty
```

### The Doc-Boundary Law

Reparenting obeys one law: **materialization is contagious**. Whatever is potentially reachable
from a doc is materialized into that doc — in both directions:

- doc-less child + doc-backed parent → the child (and its whole subtree) materializes **down**
  into the parent's doc;
- doc-backed child + doc-less parent → the parent materializes **up** into the child's doc
  (it just became reachable via `child.parent`);
- both doc-less → nothing materializes; both in the same doc → a plain reparent;
- **already materialized in *different* docs → `PlexusDocMismatchError`.** Entities never
  change docs.

The upward direction is what makes **wrap-in-place** legal:

```typescript
// wrap an existing group one level deeper, in place:
root.groups.leaf = new Group({ name: "wrapper", groups: { leaf: root.groups.leaf } });
```

The RHS evaluates first: the fresh doc-less wrapper adopts the doc-backed child from its
constructor bag — materializing upward and taking ownership of the subtree while itself still
detached — then the assignment re-attaches it one level up. A short, legal frame of doc
detachment; the inner group is the same object throughout (moved, never copied).

### Virtual Maps

> **Advanced / niche.** `@syncing.virtual(factory)` solves one specific CRDT conflict: concurrent spawn of "the same" entity by multiple peers. A deterministic genesis actor creates the child identically for everyone, so merges converge instead of duplicating. It is **not** a lazy-load mechanism — reach for it only when you hit that conflict class. Mechanism, key rules, and constraints: [docs/virtual-maps.md](./docs/virtual-maps.md).

### Map Keys

Maps use structural equality for keys — Sets, Arrays, Dates, tuples, and PlexusModel references all work:

```typescript
@syncing.map accessor byDimensions: Map<Set<string>, number> = new Map();

// Order doesn't matter for Set keys
map.set(new Set(["a", "b"]), 42);
map.get(new Set(["b", "a"])); // 42

// Arrays/tuples are order-sensitive
@syncing.map accessor events: Map<[Date, string], Event> = new Map();

// Models as keys
@syncing.map accessor scores: Map<User, number> = new Map();
```

This **differs** from native JS `Map` behavior intentionally.
Pointer-reference maps are meaningless in collaborative environments.
Structural equality, however, enables powerful many-to-one relations (hyperedges) like `Map<Set<User>, Group>`.

> Why objects are not supported as keys?
> 
> Objects are somewhat indeterministic; it's hard to say - does keys order matter? What about getters?
> What about non-enumerables? Do empty fields matter? It's hard to make those behaviors expected for everyone.
> Array and Set, however, are explicit: one is saying "order matters", another "order do not matter".

Note that only Map class is supported, not its descendants.
Classes that extend Map will be serialized into key-value pairs and re-materialized as Map field.
TypeScript cannot detect that, sadly.

## Constructor Patterns

### PlexusInit & Constructor Shape

Models accept a props object, used as an initialization structure. You have to declare them manually:

> Why? TS is not capable to make constructor depend on instance fields.

```typescript

@syncing
class MyModel extends PlexusModel {
  @syncing accessor name!: string;

  constructor(props: { name: string }) {
    super(props); // PlexusInit<this> | undefined
  }
}
```

### Omittable Fields

Nullable fields and collections can be omitted from constructors:

```typescript

@syncing
class Project extends PlexusModel {
  @syncing accessor title!: string;                // Required
  @syncing accessor description!: string | null;   // Omittable (nullable)
  @syncing.list accessor tags!: string[];           // Omittable (spawns empty)
}

new Project({ title: "Hello" }); // Only title is required
```

### Accessor Syntax

Use `!: Type | null` for nullable fields. The `= null` initializer is equivalent:

```typescript
class {
  // Both are equivalent:
  @syncing accessor owner!: User | null;
  @syncing accessor owner: User | null = null;
}
```

## Inheritance

`@syncing` is required on every level of the class hierarchy.
Pass a string to set the model name (used for CRDT type maps and cross-peer resolution):

```typescript

@syncing("SuperProject")
class SuperProject extends Project {
  // field types can be redefined in subclasses
  // @ts-expect-error - it IS typescript error, but we allow overwriting child to non-child vice-versa.
  @syncing.child accessor title: string | RichName = "";
}
```

The `declare` keyword provides type narrowing without adding syncing behavior:

```typescript

@syncing
class ConcreteGroup extends AbstractGroup {
  declare items: SpecificItem[]; // Narrows type, no decorator needed
}
```

### `syncing.declare<Out, In>()`

A void decorator extension exists solely to declare generic type parameters for TypeScript variance narrowing.
Needed when a generic model like `ExprSequence<A, B>` must interact with `ExprSequence<NarrowerA, any>`
but not `ExprSequence<NarrowerA, NarrowerB>` — without it, TypeScript infers overly strict variance and blocks valid assignments:

```typescript

@syncing
class ExprSequence<A extends Expr, B extends Expr> extends PlexusModel {
  @syncing.declare<A, Expr>() accessor head!: A;
  @syncing.declare<B, Expr>() accessor tail!: B;
}
```

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

What does require a doc:

- **Materialization** — writing to the CRDT layer for sync
- **`.uuid`** in default CRDT-native mode (throws without doc; see [Identity & UUIDs](#identity--uuids))

Some introspection behaves differently without a doc:

- `.rootAncestor` → `null` (correct: there is no Plexus root to reach)
- `.isDetached` → `false` (ephemeral entities are not considered detached — detachment is a materialized-entity concept)

Doc-free is a **one-way road**, not a symmetric mode: entities begin doc-free and materialize the
moment they become reachable from a doc (see [The Doc-Boundary Law](#the-doc-boundary-law)); they
never go back. Two ways to use it:

- **Staging** — build a subtree doc-free, attach it once; it materializes as a unit.
- **"Just better MobX"** — run entire model graphs doc-free (tests, previews, tooling): full
  reactivity and ownership physics without ever wiring up sync.

### Identity & UUIDs

Every model instance has a stable `.uuid`.
By default, UUIDs are **CRDT-native** — they encode the doc guid, client ID,
and logical clock into a single string, enabling **O(1) entity resolution**.

Because they're derived from CRDT state, accessing `.uuid` **throws without a doc**.
This is fine in production (models are materialized), but tests that inspect UUIDs on ephemeral models will crash.

**Deterministic tests.** UUIDs are always CRDT-native — there is no alternative UUID mode. (The
former env-driven arbitrary counter mode was retired in 2026-07.) For reproducible identity
in tests and fixtures, use [`.localID`](#localid--process-local-creation-order-identity): it is
minted at construction from one global counter, exists on doc-less ephemerals (where `.uuid`
throws), and `resetLocalIDs()` restarts it at 1 between tests — fixed creation order gives fixed
ids, no env var required.

`.documentId` returns the Y.Doc guid (`undefined` for unmaterialized or dependency entities).

> **Singletons & the ordinal protocol.** Plexus entities are guaranteed singletons — one object per entity, *including across materialization* — so an entity's **pointer identity never changes**. If you need to identify entities **within a session** without a doc-synced UUID (e.g. ephemeral, not-yet-materialized models, whose `.uuid` would throw), use the [`ordinal`](../common/collections/src/ordinal/) protocol (`ordinal.id(entity)`): a stable, process-local handle keyed off that pointer identity, available *before* materialization.

#### `.localID` — process-local creation-order identity

Every entity also carries a `.localID`: a plain number minted from one global counter, eagerly at
construction. It exists for **every** entity — ephemeral, rehydrated, cloned — before and independent
of materialization, and is **never serialized** (absent from `toJSON()`, the yjs wire state, and every
CRDT document). Because it is minted at construction (never lazily on first access), it is
deterministic under a fixed creation order — the identity to reach for in tests and fixtures.

**Dependency entities are the exception.** The determinism above assumes eager construction, which
holds for owned/main-doc entities but not for dependencies: `Plexus.ts`'s `#materializeDependencyEntity`
constructs an imported entity's local proxy lazily, on first access through the dependency Proxy — so
its `.localID` reflects **first-access order**, not declaration or iteration order in the source
document. That's still deterministic, but only if access order itself is fixed; fixtures needing stable
ids for imported/dependency entities should touch them in an explicit, fixed sequence rather than rely
on however the test happens to traverse them.

`resetLocalIDs()` restarts the counter at 1 — a test hook for reproducible ids between tests. Reset
only between tests: entities surviving from before the reset can collide with new ones.

The three identity surfaces, side by side:

| Surface | Scope | Available | Use for |
|---|---|---|---|
| `.uuid` | doc-synced CRDT identity | after materialization (throws before) | cross-peer references, storage |
| `.localID` | process-local, creation-order | always (minted at construction) | test determinism, ephemeral-safe identity, debug labels |
| [`ordinal.id(obj)`](../common/collections/src/ordinal/) | process-local, first-use-order | any object, plexus or not | identity for arbitrary objects outside plexus |

`.localID` deliberately mirrors the ordinal protocol but keeps its **own counter domain**: resetting
localIDs must never disturb ordinal ids (which canonicalize live path-map set keys elsewhere in the
process).

### Navigation

```typescript
entity.parent;          // parent model instance, or null
entity.parentField;     // field name on parent (e.g. "pages"), or null
entity.parentFieldKey;  // key within field: string for records, deserialized
                        // ReadonlySet/readonly array for map keys, or null
entity.rootAncestor;    // walks up parent chain to find Plexus root, or null
```

### Status

```typescript
entity.isRoot;      // true if this is the document root entity
entity.isDetached;  // true if materialized but not reachable from root
```

### Operations

```typescript
entity.detach();                             // remove from parent, returns true if was attached
entity.clone({ title: "Copy" });             // deep clone of child subtree with optional overrides
entity.toJSON();                             // plain object of all schema fields
```

**Deep Sub-Tree Cloning**: `.clone()` copies the **owned** subtree — children recurse, fresh
identity everywhere (new UUIDs, new CRDT nodes), structure preserved. Non-owning refs follow the
closure-conversion rule: a ref **rebinds** iff its target is inside the same top-level clone;
otherwise it is **preserved** verbatim (free variables stay free). This is the only globally
consistent rule. If a call site needs a free ref rebound, compose there: clone the owner that
owns both (the mapping rebinds automatically), pass a prop override
(`entity.clone({ ref: newTarget })`), or plainly assign after cloning (refs don't own —
assignment never steals).

> **Ownership-polarity trap**: a getter returning a borrowed ref and an owning constructor-bag
> field have the same static type. Feeding refs harvested from a clone into an owning field of a
> fresh entity is an **adoption**: within one doc it is legal and **moves** the original (the
> fresh owner materializes upward — wrap-in-place contagion), so if you meant "copy" you just
> stole the source's children; across docs it throws `PlexusDocMismatchError`. "Harvested from a
> clone" ≠ "safe to own". Full derivation: [`src/clone.ts`](./src/clone.ts) header.

**Native Snapshotting**: Because Plexus cleanly manages JavaScript object internals without hiding them behind opaque wrappers,
native JS utilities work flawlessly straight out of the box.
You don't need a special "snapshot protocol" for UI serialization — spread syntax (`{...entity}`),
`structuredClone(entity)`, and `JSON.stringify(entity)` natively extract everything you expect without crashing on CRDT symbols.

## Reactivity

### MobX Integration

```typescript
// Automatic register — recommended
import "@here.build/plexus/mobx/register";

// Or manual initialization
import { enableMobXIntegration } from "@here.build/plexus/mobx";

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

With MobX integration enabled, use `reaction` for fine-grained tracking:

```typescript
import { reaction } from "mobx";

const dispose = reaction(
  () => [project.title, project.members.length],
  () => console.log("Changed!")
);
// dispose() when no longer needed
```

## Transactions

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
Plexus handles it flawlessly by no-oping the inner boundary.
You can wrap any granular helper mutation in a transaction without worrying about breaking batching when composing functions together.

> MobX `action()` and `plexus.transact()` are separate — if mixing reactive systems, use both.

### Action Methods (`@syncing.action`)

`@syncing.action` runs a model method body as **one Plexus transaction per doc it touches** — a
collapsed unit of intent:

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

For each doc the body mutates, the action guarantees **one yjs transaction** (one `update` event,
delivered whole to peers), **one undo unit**, and all-or-nothing visibility of that update. Yjs
writes are deferred into a buffer while the in-memory layer applies eagerly — the body always
reads its own pending writes. Nested actions defer into the outer region; the outermost method
owns the single flush.

By default a throw is **commit-on-crash**: writes buffered before the throw still flush, then the
error rethrows — matching both hosts (JS never unwinds statements that already ran; yjs never
rolls back). Rollback is opt-in:

```typescript
@syncing.action({ rollbackIf: (e) => e instanceof PlexusCycleError })
risky() { /* ... */ } // a matching throw discards the batch — nothing hits the wire
```

Because yjs stays untouched until the flush, a rolled-back action broadcasts **nothing**, even
when the body spans multiple docs. See `src/action.ts` for the full mechanism and edge cases.

**Boundaries.** The envelope has documented edges:

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

## Liminality (Ephemeral Gestures)

Liminality holds operations on a shadow document — invisible to peers and undo history —
until explicitly committed as a single atomic delta. A 10-second slider drag becomes one undo step instead of 600.

```typescript
// Enter liminal state (operations are now ephemeral)
plexus.enterLiminality();

// User drags a slider — hundreds of writes, all held on shadow
for (const value of sliderFrames) {
  entity.opacity = value;
}

// Commit: all writes become one atomic delta, one undo step
plexus.commitLiminality();

// Or revert: all writes discarded, zero trace in history
plexus.revertLiminality();
```

### What Liminality Solves

- **Gesture coalescing:** 600 slider ticks → 1 committed delta, 1 undo step
- **Write amplification:** only the final value enters the permanent operation log
- **Undo granularity:** commit boundary IS the undo boundary — not a 500ms timer
- **Array operations:** insert/delete/splice during gestures handled correctly, including ghost Item cleanup

### Peer Preview

In-progress gestures are broadcast to peers via the awareness protocol — zero permanent operations:

```typescript
// Peers see the drag in real-time via awareness, not via CRDT sync
plexus.enterLiminality();
entity.x = 100; // peers see this as a preview
entity.x = 200; // peers see this update
plexus.commitLiminality(); // peers receive the final value via CRDT sync
```

Broadcast frequency adapts to CPU pressure via PressureObserver:
- Low pressure → smooth 60fps previews
- High pressure → throttled (preserve responsiveness)
- Tab hidden → broadcast stops entirely

Previews auto-expire after 5 minutes (collective TTL) or on disconnect (30s awareness timeout).

### Structural Liminality (Arrays)

Array operations during liminal sessions are handled via three-case dispatch:

- **Insert-only:** UndoManager undo removes liminal Items; committed delta carries them under committed namespace
- **Delete-only:** Skip UndoManager undo (would create ghost Items); committed delta is a delete-set-only update
- **Mixed:** UndoManager undo + ghost Item detection via clock range + targeted delete set cleanup

### API

```typescript
plexus.enterLiminality();          // start ephemeral session
plexus.commitLiminality();         // atomic commit → one undo step
plexus.revertLiminality();         // discard all liminal writes
plexus.isLiminal;                  // true if in a liminal session
```

> **Constraints:**
> - One active liminal session at a time per Plexus instance
> - Shadow document uses `gc: false` (tombstones accumulate over sessions)
> - State vector grows by one entry per committed session
> - Ghost cleanup depends on Yjs UndoManager creating new Items for array deletion undo

## Awareness (Presence)

`PlexusAwareness` is a multi-channel presence protocol — a fork of `y-protocols/awareness` with
the **same wire format**, so it works with existing providers (y-websocket, y-webrtc, …)
unchanged.

The difference: one user occupies **multiple clientIds**. Channel 0 carries the schema (the
ordered field names) and the heartbeat; each presence field gets its own channel with its own
clock. Fields update independently — a cursor moving at 60fps re-broadcasts only the cursor
channel, never the user's name and avatar, and a channel sleeps entirely until its value changes.

```typescript
import { PlexusAwareness } from "@here.build/plexus";

type Presence = { cursor: { x: number; y: number }; name: string };

const awareness = new PlexusAwareness<Presence>(plexus.doc);
awareness.setField("name", "V");                 // broadcast once, then sleeps
awareness.setField("cursor", { x: 10, y: 20 });  // only the cursor channel updates
awareness.getField("cursor");
awareness.clearField("cursor");

awareness.getPeerIds();     // base clientIds of live peers
awareness.getPeer(peerId);  // assembled Partial<Presence> for one peer
```

Peers time out after 30s without a channel-0 heartbeat, and all their channels are cleaned up
together. The wire codecs (`encodeAwarenessUpdate`, `applyAwarenessUpdate`,
`removeAwarenessStates`, `modifyAwarenessUpdate`) are exported for provider integration.

## Querying

```typescript
// Load entity by UUID (singleton — always same instance guarantee)
const project = plexus.loadEntity<Project>(uuid);

// Get all materialized instances of a model type
const allProjects = plexus.getAllOfType(Project);

// Reverse lookup: find all parents of a node through a specific field
for (const project of plexus.parentsOf(page, Project, "pages")) {
  // yields Project instances whose .pages contains page
}
```

**Lazy Containers**: Empty collection fields (lists, sets, records, maps) cost zero in the CRDT log until first write.
The container is materialized on demand with a deterministic identity that converges across independent peers.

**Singleton Guarantee & `O(1)` Entity Caching**: Plexus maintains an internal `WeakRef` cache of all materialized entities.
When querying nested models or resolving dependencies, you receive **the exact same TypeScript class instance in memory**.
Navigating to a model or calling `plexus.loadEntity(uuid)` performs an `O(1)` memory lookup rather than a binary search
traversing the `Y.StructStore` for entities you have already encountered.
This ensures that `entityA === entityB` strict equality checks function correctly across your application
while drastically minimizing overhead.

`parentsOf` is a generator. For child fields it yields at most one result (ownership is exclusive);
for reference fields it yields all matches.

## Tree Walking

Schema-aware child traversal inspired by [zimmerframe](https://github.com/Rich-Harris/zimmerframe):

```typescript
import { walk, buildVisitor } from "@here.build/plexus";

walk(root, initialState, {
  Project(node, ctx) {
    // visit Project nodes
    ctx.next(); // continue to children
  },
  Page(node, ctx) {
    ctx.stop(); // halt traversal
  }
});
```

`walkChildren(node, state, visitors)` walks only direct children.
`buildVisitor(visitors)` creates a type-safe visitor for reuse.

## Cross-Document Dependencies

Link data from other Y.Docs into the current document:

```typescript
const depRoot = plexus.addDependency(otherDocId, stateVector);
```

Entity pointers remain stable after linking — dependencies are potentially upgradable
(a dependency can later become a full peer or receive updates).

## Telemetry

Plexus instruments its hot paths through a no-op-by-default facade — zero overhead until an
adapter is installed. `setTelemetryAdapter(...)` routes counters, gauges, histograms, and spans
into your observability stack. Setup guide: [docs/telemetry.md](./docs/telemetry.md).

## Error Types

Plexus throws specific error types with detailed console logging for ownership violations:

| Error                        | When                                                                                                                                      |
|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `PlexusSelfAdoptionError`    | Entity tries to adopt itself                                                                                                              |
| `PlexusCycleError`           | Adoption would create a cycle in the ownership tree                                                                                       |
| `PlexusDependencyError`      | Attempting to modify a dependency entity                                                                                                  |
| `PlexusRootParentError`      | Attempting to set a parent on the root entity                                                                                             |
| `PlexusDocMismatchError`     | Adopting an entity already materialized in a *different* doc — entities never change docs                                                |
| `PlexusDuplicateChildError`  | Same child appears twice in a child array/set                                                                                             |
| `PlexusTypedArrayAliasError` | A typed-array member would hand back a live view onto the CRDT-tracked buffer (`subarray()`, `.buffer`) — take `.slice()` for a detached copy; mutate in place to sync |
| `PlexusUnstorableValueError` | Writing a value yjs cannot store to a synced field (function, symbol, `Map`/`Set`, class instance) — allowed: primitives, `Uint8Array`, plain JSON, model references |

## API Reference

```typescript
// Bootstrap a new document with root entity
const plexus = Plexus.bootstrap(root, documentId ?, doc ?);

// Connect to existing synced Y.Doc
const plexus = Plexus.connect(existingDoc);

// Core accessors
plexus.root;                              // root model instance
plexus.doc;                               // underlying Y.Doc

// Querying
plexus.loadEntity<T>(uuid);               // entity by UUID
plexus.getAllOfType(Constructor);          // all instances of type
plexus.parentsOf(node, ParentClass, field); // reverse lookup

// State management
plexus.transact(fn);                      // batched transaction
plexus.undo();                            // undo last change
plexus.redo();                            // redo last undo

// Liminality (ephemeral gestures)
plexus.enterLiminality();                 // start ephemeral session
plexus.commitLiminality();                // atomic commit → one undo step
plexus.revertLiminality();                // discard all liminal writes
plexus.isLiminal;                         // true if in liminal session

// Cross-document
plexus.addDependency(docId, stateVector); // link external doc
```

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License.
Each version converts to MIT two years after its release date.
