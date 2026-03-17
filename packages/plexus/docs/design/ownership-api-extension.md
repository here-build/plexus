# Ownership API Extension Design

## Goal

Add three features to PlexusModel:

1. `isRoot` getter - check if entity is the root
2. `isOrphan` getter - check if entity is disconnected from root
3. Cycle prevention - prevent parent loops during adoption

## API Design

```typescript
class PlexusModel {
  // Simple: is this the root entity?
  get isRoot(): boolean;

  // Is this entity disconnected from the ownership tree?
  get isOrphan(): boolean;

  // Walk up parent chain, return root or null if orphan/cycle
  get rootAncestor(): PlexusModel<null> | null;
}
```

## Semantics

### `isRoot`

Trivial: `this.uuid === "root"`

### `isOrphan`

An entity is orphan if:

1. It's materialized (has `__doc__`)
2. It's NOT root
3. Walking up parent chain does NOT reach root

Edge cases:

- **Ephemeral entity** (no `__doc__`): NOT orphan - it's just pending adoption
- **Entity in cycle**: IS orphan - cycle disconnected from root
- **Root entity**: NOT orphan by definition
- **Dependency model**: Need to decide - probably NOT orphan (belongs to external doc)

### `rootAncestor`

Walk up parent chain with cycle detection:

- Returns root if reachable
- Returns `null` if orphan or in cycle

This helper is useful for both `isOrphan` and cycle prevention.

## Cycle Prevention

### Where to check?

Two options:

**Option A: In `requestAdoptionSymbol`** (before emancipation)

```typescript
[requestAdoptionSymbol](newParent, field, metadata) {
  if (this.isAncestorOf(newParent)) {
    // newParent is in our subtree - would create cycle
    throw new Error(...) // or return silently
  }
  this.#emancipate();
  this[informAdoptionSymbol](newParent, field, metadata);
}
```

**Option B: In `informAdoptionSymbol`** (during adoption)

```typescript
[informAdoptionSymbol](newParent, field, metadata) {
  if (this.wouldCreateCycle(newParent)) {
    throw new Error(...) // or return silently
  }
  // ... rest of adoption
}
```

**Recommendation: Option A** - check before emancipation. If we check after emancipation but before adoption, the entity
is temporarily orphaned which could cause issues.

### What to do on cycle detection?

Options:

1. **Throw error** - explicit, debuggable
2. **Silent no-op** - forgiving, but hides bugs
3. **Console warning + no-op** - compromise

**Recommendation: Throw error** - cycles are always bugs in application logic. Silent failures hide bugs.

### Cycle detection algorithm

```typescript
isAncestorOf(descendant: PlexusModel): boolean {
  const visited = new Set<PlexusModel>();
  let current: PlexusModel | null = descendant;

  while (current && !visited.has(current)) {
    if (current === this) return true;
    visited.add(current);
    current = current.parent;
  }
  return false;
}
```

The `visited` Set prevents infinite loops if there's already a cycle in the tree.

## Implementation Plan

### 1. Add helper method `#walkToRoot()`

```typescript
#walkToRoot(): { root: PlexusModel<null> | null; cycle: boolean } {
  const visited = new Set<PlexusModel>();
  let current: PlexusModel | null = this;

  while (current) {
    if (visited.has(current)) {
      return { root: null, cycle: true };
    }
    visited.add(current);

    if (current.uuid === "root") {
      return { root: current as PlexusModel<null>, cycle: false };
    }
    current = current.parent;
  }
  return { root: null, cycle: false };
}
```

### 2. Add public getters

```typescript
get isRoot(): boolean {
  return this.uuid === "root";
}

get isOrphan(): boolean {
  // Ephemeral entities are not orphans
  if (!this.__doc__) return false;
  // Dependencies are not orphans (belong to external doc)
  if (this.__internals__.isDependency) return false;
  // Root is never orphan
  if (this.isRoot) return false;
  // Walk to root
  return this.#walkToRoot().root === null;
}

get rootAncestor(): PlexusModel<null> | null {
  if (!this.__doc__) return null;
  if (this.__internals__.isDependency) return null;
  return this.#walkToRoot().root;
}
```

### 3. Add cycle prevention

```typescript
[requestAdoptionSymbol](newParent, field, metadata) {
  // Check for self-adoption
  if (newParent === this) {
    throw new Error(`Plexus<${this.__type__}#${this.uuid}>: cannot adopt self`);
  }

  // Check if newParent is in our subtree (would create cycle)
  if (this.#isAncestorOf(newParent)) {
    throw new Error(
      `Plexus<${this.__type__}#${this.uuid}>: cannot be adopted by descendant ${newParent.uuid} (would create cycle)`
    );
  }

  // ... existing logic
}

#isAncestorOf(potentialDescendant: PlexusModel): boolean {
  const visited = new Set<PlexusModel>();
  let current: PlexusModel | null = potentialDescendant;

  while (current && !visited.has(current)) {
    if (current === this) return true;
    visited.add(current);
    current = current.parent;
  }
  return false;
}
```

## Questions for V

1. **Error vs silent no-op for cycles?**
    - Recommendation: Error (cycles are always bugs)
    - Alternative: Console.warn + no-op

2. **Should `isOrphan` be tracked/reactive?**
    - Current design: Computed on demand (walks parent chain)
    - Alternative: Track and emit notifications when orphan state changes
    - Recommendation: On-demand is simpler, orphan checks are rare

3. **What about existing cycles in documents?**
    - If a document already has cycles (from before this fix), loading will work
    - But attempting to modify the cycle will throw
    - Should we add a "repair" method to break existing cycles?

4. **Performance for deep trees?**
    - O(depth) for each check
    - Usually depth < 100, so negligible
    - Could cache rootAncestor, but adds complexity

5. **Naming: `isOrphan` vs `isDetached` vs `isDisconnected`?**
    - `isOrphan` - implies no parent, but could be confusing with "just created"
    - `isDetached` - clearer about disconnection from tree
    - `isDisconnected` - verbose but precise
