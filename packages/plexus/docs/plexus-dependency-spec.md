---
title: plexus dependency spec
genre: reference
status: current
tags: [plexus, architecture, performance]
created: 2026-03-24
updated: 2026-04-27
---

# Plexus Dependency System: Implementation Spec

**Status**: Implemented (2026-03-24). API surface (`addDependency`, `replaceDependency`, `removeDependency`, `getDependencyEntity`) all working. 21 cross-document tests pass including transitive deps.

## Overview

Dependency management layer supporting cross-document references, minor version updates, and transitive dependency resolution. Prioritizes minimal Yjs diff on updates and self-contained snapshots for integrity.

## Key Design Decision: projectId as Cross-Doc Key

Cross-document references use `[entityUuid, projectId]` tuples, NOT `[entityUuid, documentGuid]`. This means when a dependency is updated to a new minor version (new Y.Doc with different guid), all existing reference tuples remain valid — they point to the same `projectId`, which now resolves to a newer snapshot.

This eliminates pointer rewriting on dependency updates. The Yjs diff for a minor update is one blob replacement, not N reference tuple rewrites.

## Storage Format

### yDependencies Map

```
Y.Map<string, Uint8Array>  // key: projectId, value: singular snapshot blob
```

Each entry is a **singular snapshot blob** — one Uint8Array containing the full dependency including its transitive deps, serialized as a self-contained bundle. This differs from the current design where each dependency gets a `Y.Map<Uint8Array>` of individual entity entries.

### Snapshot Blob Format

The blob is an encoded bundle containing:

```
[header]
  version: u8                        // format version (1)
  rootUuid: string                   // UUID of the root entity (the Site/ProjectPackage)

[entities]
  count: varint                      // number of entities in this bundle
  for each entity:
    uuid: string                     // entity UUID
    sourceProjectId: string | null   // which project this entity originally belongs to
                                     // (null = belongs to this dependency's own project)
    type: string                     // model type name (e.g. "Component", "Mixin")
    attributes: any                  // serialized field values
    parentUuid: string | null        // parent entity UUID
```

The `sourceProjectId` field on each entity enables transitive dep resolution: when package A carries entities from package B, each B-entity is tagged with B's projectId. This allows the resolver to build a logical boundary map without needing separate storage per transitive dep.

### Why Singular Blob

- **Space**: one compressed blob per dependency vs one Y.Map entry per entity. The blob compresses well (entity types and field names repeat). Y.Map has per-key overhead in the Yjs CRDT structure.
- **Atomicity**: replacing a dependency is one Y.Map.set() call with one blob. Minimal Yjs operation log entry.
- **Simplicity**: loading order doesn't matter. Each blob is self-contained.
- **Tradeoff**: the entire blob must be deserialized to access any entity. For large dependencies this adds latency on first access. Acceptable for now; can move to a worker later.

## Reference Resolution

### Tuple Format

References to entities in dependencies use the tuple `[entityUuid, projectId]`. This is stored in Yjs attribute values wherever a reference field points to a dependency entity.

References to local (own-document) entities use `[entityUuid]` (no second element), same as today.

### Resolution Algorithm

```
function deref(doc, pointer, contextualProjectId?):
  if not isTupleReference(pointer): return pointer

  entityUuid = pointer[0]
  projectId = pointer[1] ?? contextualProjectId

  if projectId:
    // Cross-document: resolve from dependency blob
    blob = yDependencies.get(projectId)
    if !blob: throw "dependency not loaded"
    return materializeFromBlob(blob, entityUuid)
  else:
    // Local: resolve from own document (existing path)
    return existingLocalDeref(doc, entityUuid)
```

### Materialization from Blob

```
function materializeFromBlob(blob, entityUuid):
  // Check cache first
  if entityCache.has(projectId, entityUuid): return cached

  // Decode blob (lazy — only on first access per blob)
  entities = decodeBlobIfNeeded(blob)

  // Find entity
  entry = entities.get(entityUuid)
  if !entry: throw "entity not found in dependency"

  // Materialize with isDependency: true
  model = PlexusModel.__materializePredefined__(constructor, {
    isDependency: true,
    documentId: entry.sourceProjectId ?? projectId,  // original project for transitive deps
    uuid: entityUuid,
    parent: entry.parentUuid ? materializeFromBlob(blob, entry.parentUuid) : null,
    reference: [entityUuid, projectId],  // standard tuple order; NOT sourceProjectId — we resolve via the dep that carries it
  })

  // Hydrate fields, resolving references with context
  for each field in entry.attributes:
    if isReference(field.value):
      // The reference might point to:
      // 1. Another entity in this same blob (same or different sourceProjectId)
      // 2. An entity in a DIFFERENT dependency blob
      // Use sourceProjectId as contextualProjectId for resolution
      resolve with deref(doc, field.value, entry.sourceProjectId ?? projectId)

  cache.set(projectId, entityUuid, model)
  return model
```

### Transitive Dependency Resolution

When package A depends on package B:
- A's blob contains A's own entities (sourceProjectId = null)
- A's blob ALSO contains B's entities (sourceProjectId = B's projectId)
- References within A's entities to B's entities use `[uuid, B-projectId]`

When the consumer loads A, and also independently loads B:
- B's entities exist in TWO places: inside A's blob (as carried transitive deps) and in B's own blob
- Resolution prefers the independently loaded blob when available (it may be newer)
- Falls back to the carried copy if B is not independently loaded

Priority order for resolving `[entityUuid, projectId]`:
1. Independently loaded blob for that projectId (if exists) — this is the "highest minor wins" rule
2. Entity tagged with that sourceProjectId inside any loaded blob — transitive fallback

## API Surface

### New Methods

```typescript
class Plexus<Root> {
  /**
   * Add a dependency. Stores the blob in yDependencies keyed by projectId.
   * Throws if projectId already exists (use replaceDependency for updates).
   */
  addDependency(projectId: string, blob: Uint8Array): Root;

  /**
   * Replace an existing dependency with a new version.
   * Invalidates all materialization caches for this projectId.
   * Existing [uuid, projectId] references auto-resolve to new entities.
   * Yjs diff: one map entry replacement.
   */
  replaceDependency(projectId: string, blob: Uint8Array): Root;

  /**
   * Remove a dependency. References become dangling (deref throws).
   */
  removeDependency(projectId: string): void;

  /**
   * Resolve a specific entity from a dependency.
   * Used by deref for cross-document resolution.
   */
  getDependencyEntity(projectId: string, entityUuid: string): PlexusModel;
}
```

### Changed Behavior

- `addDependency` signature changes: first param is `projectId` (stable identifier) instead of `documentGuid` (changes per version)
- Blob format changes from `Y.Map<Uint8Array>` (per-entity entries) to `Uint8Array` (singular encoded blob)
- `deref` uses `projectId` for cross-doc resolution instead of `documentGuid`

## Blob Creation (Publish Side)

When a project publishes, the snapshot blob is created:

```
function createDependencyBlob(plexus, exportList):
  entities = []

  // 1. Collect exported entities and their owned subtrees
  for each exported entity:
    walk ownership tree, add each entity with sourceProjectId = null

  // 2. Collect referenced dependency entities (transitive)
  for each reference to a dependency entity found during walk:
    add entity with sourceProjectId = that dependency's projectId
    recursively include its owned subtree

  // 3. Encode as singular blob
  return encodeBlob(rootUuid, entities)
```

This produces a self-contained blob: all entities needed to fully materialize the package, including transitively referenced entities from other packages.

## Cache Invalidation on Replace

When `replaceDependency` is called:

1. Remove all entries for this projectId from the entity materialization cache
2. Replace the blob in `yDependencies`
3. Any MobX observers tracking dependency entities will re-trigger on next access (the cached instances are gone, new materialization happens)
4. Existing reference tuples `[uuid, projectId]` remain unchanged in the Yjs doc — zero pointer rewriting

## Migration Path

### From Current Format

Current: `yDependencies: Y.Map<Y.Map<Uint8Array>>` — outer key is documentGuid, inner map is per-entity.

New: `yDependencies: Y.Map<Uint8Array>` — key is projectId, value is singular blob.

Migration: on load, detect format (check if value is Y.Map or Uint8Array). If old format, re-encode to new format in a transaction. This is a one-time migration per document.

### Reference Tuple Migration

Current references use documentGuid as the second tuple element. New references use projectId. During migration, rewrite reference tuples to use projectId. This requires a mapping from documentGuid → projectId, available from the dependency metadata.

## Test Plan

### Unit Tests (packages/plexus)

1. **Basic add/resolve**: add dependency blob, resolve entities by UUID
2. **Read-only enforcement**: dependency entities reject writes
3. **Replace dependency**: replace blob, verify new entities materialize, old cache invalidated
4. **Remove dependency**: remove blob, verify deref throws for removed projectId
5. **Cross-doc references**: entity A references entity B via `[uuid, projectId]`, both in same blob
6. **Transitive deps (P0 fix)**: package A carries entities from package B (different sourceProjectId). Load A's blob. Resolve B's entities via A's blob.
7. **Transitive deps with independent load**: load both A (carries B) and B independently. Verify B's entities resolve from B's own blob (higher priority).
8. **Replace with new entities**: replace dependency, verify new entities added since last version are accessible
9. **Replace with removed entities**: replace dependency, verify removed entities cause deref failure
10. **Multiple dependencies**: load A, B, C. Cross-references between them all resolve.
11. **Blob round-trip**: create blob → load blob → verify all entities match original

### Integration Tests (consumer apps)

Consumers that mount multiple documents should cover: add/remove dependency,
blob refresh after remote updates, and resolution of entities across the
dependency edge. Keep those tests in the consumer repo — not here.


## Open Questions

1. **Blob compression**: should the blob be zlib/brotli compressed inside the Uint8Array? Reduces storage and sync payload but adds CPU cost on decode. Probably worth it for large deps.

2. **Lazy blob decoding**: the entire blob must be decoded on first access to any entity. For a dependency with 500 entities, this is noticeable. Should we decode on demand (per entity) or eagerly (on load)? Per-entity decoding needs an index/offset table in the blob format.

3. **Worker offloading**: blob decoding could run in a Web Worker to avoid main thread blocking. The entity cache would need to be shared or message-passing-based. Deferred to later.

4. **Garbage collection of carried transitive deps**: if A's blob carries B's entities, and B is also independently loaded, the carried copies in A's blob are redundant. Should they be evicted from A's blob on next publish of A? Or kept for integrity?
