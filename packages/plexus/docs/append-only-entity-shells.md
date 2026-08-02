---
title: append only entity shells
genre: proposal
status: done
tags: [plexus, architecture, performance]
created: 2026-04-08
updated: 2026-04-27
---

# Append-Only Entity Shells: Undo/Redo Identity Preservation

> **Status**: ✅ Shipped — `deleteFilter` + materialization clock live.
> **Implementation**: `foundations/plexus/src/Plexus.ts:349` (deleteFilter setup). `isDematerialized` removed per plexus-undo-architecture rework (2026-04-08).
> **Note**: document preserved as design record. Round 2 test-failure analysis below superseded by later work (see memory: plexus-undo-architecture).

## Problem Statement

When Yjs UndoManager reverts entity creation, nested child entity UUIDs become unstable — they get reconstructed as new objects on redo. This breaks reference integrity, object identity, and `parentsOf` queries.

### Evidence

Tests confirm (see `public-packages/plexus/src/__tests__/6-history/uuid-stability-undo-redo.test.ts`):
- Without deleteFilter: nested child UUIDs NOT stable on redo
- With deleteFilter: 4/6 core tests pass, including nested children

## Solution: deleteFilter on UndoManager

Entity shells in typeMap are protected from deletion during undo. The `deleteFilter` returns `false` for Items that are entity shell entries in type sub-maps.

```ts
this.__undoManager__ = new UndoManager(this.yTypes, {
  deleteFilter: (item) => {
    const parent = item.parent;
    if (parent instanceof Y.Map && item.parentSub !== null) {
      if (typeSubMaps.has(parent)) return false; // protect entity shell
    }
    return true;
  },
});
```

### Why This Works

**Critical finding from Round 2**: Plexus already stores child references as UUID string tuples (`ReferenceTuple`), NOT embedded XmlElements. XmlElements live exclusively in the typeMap. Parent containers (Y.Array for child-list, Y.Map for child-map) hold `["uuid"]` tuples.

This means:
- Redo on parent containers copies UUID strings — no `XmlElement._copy()` duplication
- The only XmlElement at risk is the typeMap entry itself — protected by deleteFilter
- Entity identity is preserved through the UUID string indirection that already exists

The Round 1 CRDT review's "fatal flaw" (redo creates duplicate XmlElements for child entities) was based on an incorrect assumption about the storage format. Parent containers never held XmlElements.

### Verified behavior (4/6 tests passing):
- Child entity UUID stable after undo + redo ✓
- List child UUIDs stable after undo + redo ✓
- Multiple undo/redo cycles (5+) ✓
- Nested child UUIDs stable after undo + redo ✓

### Remaining failures (2/6):
- Field value undo granularity — `captureTimeout` batching merges shell creation and field writes into one undo stack item, causing fields to revert to null instead of creation values

## Remaining Open Problems

### Problem 1: Field value floor state

When undo reverts past entity creation, fields revert to Yjs zero state (null/undefined). The entity shell survives but has no field values.

**Recommended solution (from State Machine review)**: Option A + TypeScript defaults at the decorator level. When `backingStorage` returns undefined, the decorator getter returns the TypeScript schema default. No new Yjs mechanism needed. Entities always return valid values.

**Implementation**: in the decorator getter (decorators.ts), when the backing value is undefined/null and the entity is materialized, return the field's TypeScript default value instead.

### Problem 2: `getAllOfType` orphan pollution

`getAllOfType` iterates typeMap and materializes every entity. Orphaned shells (detached entities from undo) appear in results, poisoning `parentsOf` queries with dead entities.

**Required**: maintain a `Set<PlexusUUID>` of live (attached) entities, or add an `isDetached` filter to `getAllOfType`. The `parentsOf` implementation already iterates `getAllOfType` — filtering there is the minimal fix.

**Performance fix**: deleteFilter should use a pre-built `Set<Y.Map>` of type sub-maps instead of iterating `yTypesRef.values()` per Item.

### Problem 3: MobX reactions during undo

When undo reverts parent pointer, `trackModification` fires synchronously. MobX reactions observing `.parent` re-run within the undo transaction. If a reaction writes to the now-detached entity, it could corrupt state.

**Required**: either (a) set `__isUndoing__` flag and suppress writes during undo, or (b) make detached-entity writes silently no-op during undo transactions (not throw).

### Problem 4: Rapid undo/redo render flicker

Each undo/redo triggers MobX observation updates. Fields flash through null/floor state. React may render intermediate states.

**Mitigation**: the existing `__isUndoing__` flag could be used to batch/defer MobX notifications until the undo/redo completes. The `flushNotifications` mechanism in `utils.ts` already supports deferred notification delivery.

### Problem 5: Concurrent peer writes during undo window

Peer A undoes, entity detaches. Peer B writes to entity (doesn't know it's undone on A). A redoes. Result: merged state from A's redo + B's concurrent writes. Neither peer authored this combination.

**Assessment**: inherent to CRDTs with undo. Not solvable without distributed undo coordination. Document as known behavior: redo is best-effort in concurrent scenarios.

### Problem 6: Document size growth

Append-only entities mean typeMap grows monotonically. Orphaned shells persist.

**Mitigation**: 
- XmlElement shells are small (~200-400 bytes each)
- Clear orphans when undo stack is emptied (safe — no redo possible)
- Consider an undo stack cap (50-100 items) that triggers orphan GC
- WeakRef in documentEntityCaches means JS objects are GC'd; only Yjs-side persists

### Problem 7: Dematerialization code path

The current undo observer (Plexus.ts:449) sets `isDematerialized = true` on `change.action === "delete"`. With deleteFilter, this branch never fires for entity shells. The dematerialization concept becomes mostly obsolete.

**Required**: review all `isDematerialized` usage sites. For entity shells, the state transitions to detached (no parent), not dematerialized (no existence). The `isDetached` getter already handles this. The dematerialization code path may still be needed for non-typeMap deletions (e.g., Yjs GC of truly abandoned entities).

### Problem 8: Two contradictory test suites

`dematerialization.test.ts` asserts `isDematerialized === true` and field access throws.
`uuid-stability-undo-redo.test.ts` asserts `isDematerialized === false` after undo.

These describe mutually exclusive state machines. Once deleteFilter is universal, `dematerialization.test.ts` tests become wrong.

**Required**: reconcile test suites. Dematerialization tests should either be updated to reflect the new behavior or moved to test only non-deleteFilter scenarios (edge cases, GC).

## Implementation Plan

### Phase 1: Core deleteFilter (minimal, validated by existing tests)

1. Add `deleteFilter` to UndoManager construction in Plexus.ts
2. Build `Set<Y.Map>` of type sub-maps for O(1) lookup
3. Update `uuid-stability-undo-redo.test.ts` to pass all 6 tests
4. Fix captureTimeout issue for field value floor state

### Phase 2: Orphan management

5. Add `isDetached` filter to `getAllOfType` (or maintain live-entity index)
6. Ensure `parentsOf` excludes detached orphans
7. Add orphan GC when undo stack clears

### Phase 3: Undo safety

8. Add `__isUndoing__` guard for write suppression during undo
9. Defer MobX notification flush until undo/redo completes
10. Reconcile dematerialization test suite

### Phase 4: Validation

11. Multi-peer undo/redo tests
12. Stress test: 100+ entity undo cycles, check doc size
13. Performance benchmark: `parentsOf` with orphans vs without

## Ruled Out Alternatives

### Alternative C: Post-redo reconciliation
Fragile — must catch every code path. Race conditions between observation and reconciliation.

### Alternative D: Redo interception
**Dead end.** No Yjs hook exists between redo item creation and transaction commit. Replacing XmlElements post-integration corrupts Yjs internal `_item` back-pointers. Would require forking Yjs.

### Alternative A: GENESIS_ORIGIN for entity creation
Feasible (~100-150 lines refactor) but unnecessary now that the "fatal flaw" is disproven. The two-pass `materializeShell`/`populateContent` split is architecturally clean but adds complexity that deleteFilter alone doesn't need. **Keep as fallback** if deleteFilter proves insufficient for edge cases.

### Alternative B: UUID indirection for child references  
**Already implemented.** Plexus already uses UUID tuples for child references. This is the status quo, not an alternative.
