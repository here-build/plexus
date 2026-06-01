# Shadow Casting Design Document

> **STATUS (2026-06-01): ASPIRATIONAL DESIGN — the `castShadow()` / `PlexusShadow` API below is NOT
> built.** Only the "Validated Prerequisites" (Yjs/CRDT primitives) exist. The concept SHIPPED in a
> simpler, divergent form called **liminality**: a session on the `Plexus` instance —
> `plexus.enterLiminality()` / `commitLiminality()` / `revertLiminality()` / `isLiminal`
> (`src/Plexus.ts:709/725/780/669`), tested in `src/__tests__/8-liminality/`. Liminality is
> single-level (no per-model `castShadow`, no `PlexusShadow` object, no scope/strictness/nesting/
> introspection). Treat everything below as the *target vision*, not current API. See the
> "Liminality (peer preview)" section in `.claude/rules/plexus.md` for the real shipped surface.

## Overview

Shadow casting enables isolated editing environments over Plexus documents with atomic commit semantics. Think of it as
**git branches for reactive state** - you can fork a document, make changes in isolation, and merge back atomically.

## Validated Prerequisites

All foundational behaviors have been validated through tests in
`src/__tests__/0-foundations/shadow-prerequisites.test.ts`.

### Yjs Infrastructure (Validated ✅)

| Capability                     | Test                                                                 | Status |
|--------------------------------|----------------------------------------------------------------------|--------|
| State vector capture           | `should capture state vector at a point in time`                     | ✅      |
| Y.diffUpdate for minimal diffs | `should produce correct diff for document cloning scenario`          | ✅      |
| Concurrent CRDT merge          | `should handle concurrent changes in original during shadow editing` | ✅      |
| State vector after many ops    | `should diff correctly after many operations`                        | ✅      |
| Cloned doc state vectors       | `should handle state vector from cloned doc`                         | ✅      |

### Entity Cache Isolation (Validated ✅)

| Capability                      | Test                                                                           | Status |
|---------------------------------|--------------------------------------------------------------------------------|--------|
| Separate cache per Y.Doc        | `should maintain separate entity caches per Y.Doc`                             | ✅      |
| Same UUID = different instances | `should create separate PlexusModel instances for same UUID in different docs` | ✅      |

Shadow documents automatically get isolated entity caches - no extra work needed.

### Update Origin Filtering (Validated ✅)

| Capability                  | Test                                             | Status |
|-----------------------------|--------------------------------------------------|--------|
| Origin received in callback | `should receive origin in update callback`       | ✅      |
| Filter updates by origin    | `should be able to filter updates by origin`     | ✅      |
| One-way liminal sync        | `should enable one-way sync for liminal shadows` | ✅      |

Liminal shadows can filter updates using Yjs origin parameter.

### docPlexus Registration (Validated ✅)

| Capability                | Test                                            | Status |
|---------------------------|-------------------------------------------------|--------|
| Registration on bootstrap | `should register doc in docPlexus on bootstrap` | ✅      |
| Registration on connect   | `should register doc in docPlexus on connect`   | ✅      |

Shadow documents require Plexus registration via `Plexus.connect()` or similar.

### Undo/Redo (Validated ✅)

| Capability              | Test                                                    | Status |
|-------------------------|---------------------------------------------------------|--------|
| Transaction batching    | `should create single undo step for transacted changes` | ✅      |
| Undo notifications fire | `should track modifications from UndoManager.undo()`    | ✅      |
| Redo notifications fire | `should track modifications from UndoManager.redo()`    | ✅      |

Notifications work correctly during undo/redo - no issues found.

### Core Patterns Validated

**Shadow creation:**

```typescript
const baseStateVector = Y.encodeStateVector(originalDoc);
const shadowDoc = new Y.Doc();
Y.applyUpdate(shadowDoc, Y.encodeStateAsUpdate(originalDoc));
```

**Shadow commit:**

```typescript
const shadowUpdate = Y.encodeStateAsUpdate(shadowDoc);
const diff = Y.diffUpdate(shadowUpdate, baseStateVector);
Y.applyUpdate(originalDoc, diff);  // Minimal diff applied
```

**Liminal one-way sync:**

```typescript
originalDoc.on("update", (update, origin) => {
  Y.applyUpdate(shadowDoc, update);  // Shadow receives all origin changes
});
// Shadow's local changes stay isolated until commit
```

**Origin filtering:**

```typescript
const SHADOW_ORIGIN = Symbol("shadow");
doc.on("update", (update, origin) => {
  if (origin !== SHADOW_ORIGIN) {
    // Process only non-shadow updates
  }
});
```

### Core Concepts

**Shadow** - A cloned document state that allows isolated edits. Changes accumulate in the shadow until explicitly
committed or aborted.

**Liminal Shadow** - A shadow that receives updates from the origin document (one-way sync). You see others' changes
flowing in while your edits remain isolated until commit.

**Shadow Chain** - Shadows can be nested. Shadow B can be cast from Shadow A, which was cast from the Original document.

```
Original ← Shadow A ← Shadow B
           ↑ origin    ↑ shadowCast
```

## Mental Model

```
┌─────────────────────────────────────────────────────────────┐
│                    ORDINARY SHADOW                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Original Doc (SV₀)                                         │
│       │                                                     │
│       │ castShadow()                                        │
│       │ ─────────────────────────────────────────────────── │
│       │   1. encodeStateAsUpdate(original)                  │
│       │   2. applyUpdate(shadowDoc, update)                 │
│       │   3. Store baseStateVector = SV₀                    │
│       ▼                                                     │
│  Shadow Doc (starts at SV₀)                                 │
│       │                                                     │
│       │ local edits...                                      │
│       ▼                                                     │
│  Shadow Doc (now at SV₁)                                    │
│       │                                                     │
│       │ commit()                                            │
│       │ ─────────────────────────────────────────────────── │
│       │   1. diff = Y.diffUpdate(shadowDoc, baseStateVector)│
│       │   2. plexus.transact(() => applyUpdate(origin, diff))│
│       ▼                                                     │
│  Original Doc atomically updated                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    LIMINAL SHADOW                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Original Doc ──── on('update') ────→ Shadow Doc            │
│       │            (one-way pipe)         │                 │
│       │                                   │ local edits     │
│       ▼                                   ▼                 │
│  Continues evolving              Receives updates +         │
│  from other clients              accumulates local changes  │
│                                          │                  │
│                                          │ commit()         │
│                                          │ ──────────────── │
│                                          │ diff from CURRENT│
│                                          │ origin SV        │
│                                          ▼                  │
│                               Only YOUR unique changes      │
│                               applied to origin             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## API Surface

### PlexusModel Extensions

```typescript
class PlexusModel {
  /**
   * Cast an ordinary shadow from this model.
   * Returns isolated editing environment.
   */
  castShadow(options?: ShadowOptions): PlexusShadow<this>;

  /**
   * Cast a liminal shadow from this model.
   * Receives origin updates while isolating local edits.
   */
  castLiminalShadow(options?: ShadowOptions): PlexusShadow<this>;

  /**
   * Unified introspection accessor.
   * Avoids polluting model namespace with multiple properties.
   */
  get introspection(): PlexusIntrospection<this>;
}

interface ShadowOptions {
  /**
   * Scope constraint for shadow edits.
   * - "full": No constraints, entire document editable
   * - "subtree": Only children of shadow root editable, throws on violation
   * - "subtree-warn": Only children editable, warns on violation
   *
   * Default: "full"
   */
  scope?: "full" | "subtree" | "subtree-warn";
}
```

### PlexusShadow Class

```typescript
class PlexusShadow<T extends PlexusModel = PlexusModel> {
  /**
   * The shadow root model - entry point for shadow edits.
   * Same UUID as the caster, but in shadow context.
   */
  readonly model: T;

  /**
   * The model that cast this shadow (in origin context).
   */
  readonly caster: T;

  /**
   * Whether this is a liminal shadow (receives origin updates).
   */
  readonly isLiminal: boolean;

  /**
   * Scope constraint for this shadow.
   */
  readonly scope: "full" | "subtree" | "subtree-warn";

  /**
   * Current state of the shadow.
   */
  readonly state: "active" | "committed" | "aborted";

  /**
   * The origin - either a Plexus instance or parent PlexusShadow.
   */
  readonly origin: Plexus | PlexusShadow;

  /**
   * Root Plexus instance (traverses shadow chain).
   */
  readonly rootOrigin: Plexus;

  /**
   * Nesting depth (0 = direct shadow of Plexus).
   */
  readonly depth: number;

  /**
   * Child shadows cast from this shadow.
   */
  readonly childShadows: ReadonlySet<PlexusShadow>;

  /**
   * Commit shadow changes to origin.
   * Computes diff and applies atomically.
   *
   * For ordinary shadow: diff from baseStateVector
   * For liminal shadow: diff from current origin state vector
   *
   * After commit:
   * - Shadow state becomes "committed"
   * - Child shadows reconnect to origin (see Nested Shadow Lifecycle)
   * - Shadow resources are disposed
   */
  commit(): void;

  /**
   * Abort shadow, discarding all changes.
   *
   * After abort:
   * - Shadow state becomes "aborted"
   * - Child shadows reconnect to origin with warning
   * - Shadow resources are disposed
   */
  abort(): void;

  /**
   * Load an entity within shadow context by UUID.
   */
  loadEntity<M extends PlexusModel>(uuid: PlexusUUID<M>): M;

  /**
   * Shadow-specific undo manager.
   * Isolated from origin's undo stack.
   */
  readonly undoManager: Y.UndoManager;

  /**
   * Check if a model is within this shadow's editable scope.
   */
  isInScope(model: PlexusModel): boolean;
}
```

### Plexus Extensions

```typescript
class Plexus {
  /**
   * Document-level strictness mode.
   * Affects cross-boundary behavior throughout the document.
   */
  readonly strictness: "none" | "warn" | "throw";

  /**
   * All active shadows cast from this document (direct children only).
   */
  readonly shadows: ReadonlySet<PlexusShadow>;
}

// Bootstrap with strictness
const plexus = Plexus.bootstrap(root, doc, {
  strictness: "warn"  // Default
});
```

### Introspection API

```typescript
class PlexusIntrospection<T extends PlexusModel> {
  /**
   * Shadow-related introspection.
   * Null if model is not in a shadow context.
   */
  get shadow(): ShadowIntrospection<T> | null;

  /**
   * Schema information for this model.
   */
  get schema(): PlexusSchema;

  /**
   * Parent relationship info.
   */
  get parent(): { model: PlexusModel; key: string } | null;

  /**
   * All child relationships.
   */
  get children(): Map<string, PlexusModel[]>;

  /**
   * The context this model belongs to.
   */
  get context(): Plexus | PlexusShadow;
}

interface ShadowIntrospection<T extends PlexusModel> {
  /**
   * The PlexusShadow this model belongs to.
   */
  context: PlexusShadow;

  /**
   * Root Plexus document.
   */
  rootOrigin: Plexus;

  /**
   * Nesting depth.
   */
  depth: number;

  /**
   * Whether this is a liminal shadow.
   */
  isLiminal: boolean;

  /**
   * Scope constraint.
   */
  scope: "full" | "subtree" | "subtree-warn";

  /**
   * Shadow state.
   */
  state: "active" | "committed" | "aborted";

  /**
   * Corresponding model in origin context.
   * Null if model was created within shadow.
   */
  originModel: T | null;

  /**
   * Whether origin has changed since shadow was cast.
   * Only meaningful for liminal shadows.
   */
  hasDiverged: boolean;

  /**
   * Whether this model was deleted in origin.
   * Only meaningful for liminal shadows.
   */
  wasDeletedInOrigin: boolean;
}
```

## Yjs Mechanics

### State Vector Operations

```typescript
// Capture current state
const stateVector = Y.encodeStateVector(doc);

// Full document snapshot
const snapshot = Y.encodeStateAsUpdate(doc);

// Clone document
const cloneDoc = new Y.Doc();
Y.applyUpdate(cloneDoc, snapshot);

// Compute minimal diff from state vector
const diff = Y.diffUpdate(modifiedDoc, originalStateVector);

// Apply diff atomically
Y.applyUpdate(targetDoc, diff);
```

### Ordinary Shadow Implementation

```typescript
castShadow(options?: ShadowOptions): PlexusShadow<this> {
  const originDoc = this.__internals__.plexus.doc;

  // 1. Capture base state
  const baseStateVector = Y.encodeStateVector(originDoc);
  const snapshot = Y.encodeStateAsUpdate(originDoc);

  // 2. Create shadow document
  const shadowDoc = new Y.Doc();
  Y.applyUpdate(shadowDoc, snapshot);

  // 3. Create shadow context
  return new PlexusShadow({
    caster: this,
    origin: this.__internals__.plexus,
    shadowDoc,
    baseStateVector,
    isLiminal: false,
    scope: options?.scope ?? "full",
  });
}
```

### Liminal Shadow Implementation

```typescript
castLiminalShadow(options?: ShadowOptions): PlexusShadow<this> {
  const shadow = this.castShadow(options);

  const originDoc = this.__internals__.plexus.doc;

  // One-way sync: origin → shadow
  const updateHandler = (update: Uint8Array, origin: any) => {
    // Don't echo back shadow's own updates
    if (origin !== shadow) {
      Y.applyUpdate(shadow.doc, update);
    }
  };

  originDoc.on('update', updateHandler);

  // Store for cleanup
  shadow._liminalUnsub = () => originDoc.off('update', updateHandler);
  shadow._isLiminal = true;

  return shadow;
}
```

### Commit Implementation

```typescript
// Ordinary shadow
commit(): void {
  if (this.state !== "active") {
    throw new PlexusShadowStateError(this.state);
  }

  // Compute diff from original base state
  const diff = Y.diffUpdate(this.doc, this._baseStateVector);

  // Apply atomically (single undo step)
  this.rootOrigin.transact(() => {
    Y.applyUpdate(this.rootOrigin.doc, diff);
  });

  this._handleChildShadowsOnCommit();
  this._dispose();
  this._state = "committed";
}

// Liminal shadow
commit(): void {
  if (this.state !== "active") {
    throw new PlexusShadowStateError(this.state);
  }

  // For liminal: diff from CURRENT origin state
  // This excludes changes we received via sync
  const currentOriginSV = Y.encodeStateVector(this.origin.doc);
  const diff = Y.diffUpdate(this.doc, currentOriginSV);

  this.rootOrigin.transact(() => {
    Y.applyUpdate(this.rootOrigin.doc, diff);
  });

  this._handleChildShadowsOnCommit();
  this._dispose();
  this._state = "committed";
}
```

## Nested Shadow Lifecycle

### Shadow Chain Structure

```
Plexus (root)
  └── Shadow A (depth: 0)
        └── Shadow B (depth: 1)
              └── Shadow C (depth: 2)
```

### On Parent Shadow Commit

When Shadow A commits:

1. **A's changes merge into Plexus**
2. **Child shadows (B) reconnect:**

   For **ordinary child shadow**:
    - B's origin pointer updates to A's merge point in Plexus
    - B's baseStateVector updates to post-merge state
    - B continues as shadow of Plexus

   For **liminal child shadow**:
    - B reconnects to Plexus document stream
    - B's sync subscription transfers to Plexus
    - B continues receiving Plexus updates

```typescript
_handleChildShadowsOnCommit(): void {
  for (const child of this.childShadows) {
    // Reconnect to our origin (which is now committed)
    child._reconnectTo(this.origin);

    if (child.isLiminal) {
      // Transfer sync subscription
      child._transferSyncTo(this.rootOrigin.doc);
    } else {
      // Update base state vector to post-merge
      child._baseStateVector = Y.encodeStateVector(this.rootOrigin.doc);
    }
  }
}
```

### On Parent Shadow Abort

When Shadow A aborts:

1. **A's changes are discarded**
2. **Child shadows (B) reconnect with warning:**

   For **ordinary child shadow**:
    - B reconnects to A's original origin (Plexus)
    - B's baseStateVector updates to current Plexus state
    - Console warning: "Shadow reconnected due to parent abort"

   For **liminal child shadow**:
    - B reconnects to Plexus document stream
    - B enters "orphaned" state
    - Console warning: "Liminal shadow orphaned - parent aborted"
    - Commit attempt on orphaned liminal shadow produces additional warning

```typescript
_handleChildShadowsOnAbort(): void {
  for (const child of this.childShadows) {
    console.warn(
      `[Plexus] Shadow reconnected due to parent abort. ` +
      `Shadow depth reduced from ${child.depth} to ${child.depth - 1}.`
    );

    child._reconnectTo(this.origin);

    if (child.isLiminal) {
      child._isOrphaned = true;
      console.warn(
        `[Plexus] Liminal shadow orphaned - parent aborted. ` +
        `Commit will apply changes but may have unexpected results.`
      );
    }

    child._baseStateVector = Y.encodeStateVector(this.origin.doc);
  }
}
```

## Strictness Modes

Document-level strictness affects multiple behaviors:

### Cross-Context Transactions

```typescript
plexus.transact(() => {
  shadowModel.field = "a";   // Shadow context
  originalModel.field = "b"; // Original context
});
```

| Mode      | Behavior                             |
|-----------|--------------------------------------|
| `"none"`  | Silent, both writes proceed          |
| `"warn"`  | Console warning, both writes proceed |
| `"throw"` | Throws `PlexusCrossContextError`     |

### Cross-Boundary References

```typescript
// In shadow context
shadowProject.owner = originalUser;
```

| Mode      | Behavior                                     |
|-----------|----------------------------------------------|
| `"none"`  | Auto-resolve to shadow copy, silent          |
| `"warn"`  | Auto-resolve to shadow copy, console warning |
| `"throw"` | Throws `PlexusCrossBoundaryReferenceError`   |

### Out-of-Scope Shadow Edits

```typescript
const shadow = root.castShadow({ scope: "subtree" });
shadow.model.parent.sibling.field = "x"; // Outside subtree
```

| Scope            | Behavior                        |
|------------------|---------------------------------|
| `"full"`         | Allowed                         |
| `"subtree"`      | Throws `PlexusShadowScopeError` |
| `"subtree-warn"` | Console warning, write proceeds |

### Orphaned Liminal Shadow Commit

```typescript
const shadowA = model.castLiminalShadow();
const shadowB = shadowA.model.castLiminalShadow();
shadowA.abort(); // B is now orphaned
shadowB.commit(); // Orphaned commit
```

| Mode      | Behavior                                 |
|-----------|------------------------------------------|
| `"none"`  | Silent, commit proceeds                  |
| `"warn"`  | Console warning, commit proceeds         |
| `"throw"` | Throws `PlexusOrphanedShadowCommitError` |

## Memory Management

### Automatic Cleanup

```typescript
commit(): void {
  // ... apply diff ...
  this._dispose();
}

abort(): void {
  this._dispose();
}

_dispose(): void {
  // Unsubscribe liminal sync
  this._liminalUnsub?.();

  // Clear entity cache
  this._entityCache.clear();

  // Destroy undo manager
  this._undoManager.destroy();

  // Clear from parent's child set
  this.origin.shadows?.delete(this);

  // Notify child shadows
  // (they reconnect, don't dispose)
}
```

### Abandoned Shadows

Shadows that are never committed/aborted:

1. **Liminal sync uses WeakRef** - If shadow is GC'd, sync handler auto-cleans
2. **Entity cache doesn't prevent GC** - Shadow models are normal objects
3. **No explicit dispose required** - Natural GC handles cleanup

```typescript
// Liminal sync with WeakRef
const shadowRef = new WeakRef(shadow);

const updateHandler = (update: Uint8Array) => {
  const shadow = shadowRef.deref();
  if (!shadow) {
    // Shadow was GC'd, unsubscribe
    originDoc.off('update', updateHandler);
    return;
  }
  Y.applyUpdate(shadow.doc, update);
};
```

## Undo/Redo Semantics

### Shadow Has Isolated Undo Stack

```typescript
const shadow = model.castShadow();

shadow.model.title = "A";
shadow.model.title = "B";
shadow.model.title = "C";

shadow.undoManager.undo(); // title = "B"
shadow.undoManager.undo(); // title = "A"
shadow.undoManager.redo(); // title = "B"
```

### Commit Creates Single Undo Step

```typescript
// Original undo stack: [edit1, edit2]

const shadow = model.castShadow();
shadow.model.title = "X";
shadow.model.description = "Y";
shadow.model.count = 42;
shadow.commit();

// Original undo stack: [edit1, edit2, shadowCommit]
// One undo() reverts ALL shadow changes atomically

plexus.undoManager.undo();
// title, description, count all reverted
```

### Abort Leaves No Trace

```typescript
// Original undo stack: [edit1, edit2]

const shadow = model.castShadow();
shadow.model.title = "X";
shadow.model.description = "Y";
shadow.abort();

// Original undo stack: [edit1, edit2]
// No trace of shadow edits
```

## Edge Cases

### Creating New Entities in Shadow

```typescript
const shadow = project.castShadow();
const newPage = new Page({ title: "New" });
shadow.model.pages.push(newPage);
shadow.commit();

// newPage now exists in original document
// Same UUID, materialized in original
```

### Deleting Entities in Shadow

```typescript
const shadow = project.castShadow();
const page = shadow.model.pages[0];
shadow.model.pages.splice(0, 1);
shadow.commit();

// page is removed from original document
```

### Liminal: Origin Deletes What Shadow Is Editing

```typescript
const shadow = project.castLiminalShadow();
const page = shadow.model.pages[0];

// Meanwhile, in origin:
project.pages.splice(0, 1);

// Shadow receives this update
// page.introspection.shadow.wasDeletedInOrigin === true

// If shadow commits:
// - Page is RE-CREATED in origin (shadow's version wins)
// - This may or may not be desired - user decides
```

### Reparenting Across Shadow Boundary

```typescript
const shadow = project.castShadow();
const page = shadow.model.pages[0];

// Try to move to original context
originalProject2.pages.push(page);

// Behavior depends on strictness:
// - "throw": PlexusCrossBoundaryReferenceError
// - "warn": Auto-resolve, page moved within shadow's project2 copy
// - "none": Same as warn, silent
```

## Implementation Phases

### Phase 1: Core Shadow Infrastructure

1. `PlexusShadow` class with basic structure
2. `castShadow()` implementation (non-liminal)
3. `commit()` with Y.diffUpdate
4. `abort()` with cleanup
5. Basic introspection (`model.introspection.shadow`)

### Phase 2: Liminal Shadows

1. One-way sync subscription
2. `castLiminalShadow()` implementation
3. Liminal-specific diff (from current origin SV)
4. WeakRef cleanup for abandoned shadows
5. `hasDiverged` and `wasDeletedInOrigin` detection

### Phase 3: Nested Shadows

1. Shadow chain tracking
2. Child shadow reconnection on commit
3. Child shadow reconnection on abort
4. Orphaned shadow warnings
5. Depth tracking

### Phase 4: Strictness & Scope

1. Document-level strictness config
2. Cross-context transaction detection
3. Cross-boundary reference auto-resolution
4. Scope constraint enforcement
5. All error types

### Phase 5: Undo/Redo Integration

1. Shadow-isolated UndoManager
2. Atomic commit as single undo step
3. Abort leaves no trace
4. Nested shadow undo isolation

### Phase 6: Testing & Edge Cases

1. Comprehensive test suite per phase
2. Stress tests (large documents, many shadows)
3. Concurrent liminal shadows
4. Rapid commit/abort cycles
5. Memory leak verification

## Open Questions

1. **Shadow of dependency entity** - Can you cast shadow on a read-only dependency? Probably no - throw immediately.

2. **Partial document shadow** - Current design shadows entire document. Could we shadow only a subtree's Yjs structure
   for memory efficiency?

3. **Shadow serialization** - Can shadows be persisted and restored? Would need to serialize base state vector and
   shadow doc state.

4. **Shadow merge conflicts** - Tests confirm CRDT merge handles concurrent edits correctly (last-write-wins semantics).
   For liminal shadows editing the same field as origin, shadow's value wins on commit. Should we provide visibility
   into what was overwritten?

5. **Shadow branching UI** - How should Here.build surface shadow state to users? Version history panel? Branch
   indicators?
