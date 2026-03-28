# Referential Completeness: Self-Resolving References as a Sync Invariant for CRDTs

> Draft — positioned for PaPoC or Local-First Conference (workshop paper, ~5 pages)

## Abstract

CRDT sync protocols guarantee convergence — all peers that exchange updates eventually reach the same state. They do not guarantee referential completeness — that a peer has all entities referenced by the entities it holds. We show that self-resolving entity identity [1] makes referential completeness computable: every reference in a CRDT document is decodable to a physical address, enabling automatic transitive closure of the reference graph from any root. Missing entities are detectable without a registry, a server, or manual specification. Combined with an ownership tree, the reference graph becomes the sync specification — the system can determine "do I have everything I need?" from the document alone. We formalize the completeness check and describe its application to dependency loading, awareness entity resolution, and partial sync in a production CRDT framework (Plexus/Yjs).

## 1. The Completeness Gap

CRDT sync protocols provide a strong guarantee: **convergence.** Two peers that exchange all their updates will reach identical state. This is the foundational property that makes CRDTs useful for collaboration without coordination.

But convergence says nothing about **completeness.** A peer may converge on a consistent state that contains dangling references — pointers to entities that exist on other peers but have not been synced locally. The CRDT is "correct" (it has processed all updates it received) but the application is broken (it cannot resolve its own references).

### 1.1 Where Dangling References Arise

**Partial sync.** A large document is loaded incrementally — the current page first, other pages on demand. Entity A on the current page references entity B on an unloaded page. The reference exists in the CRDT state, but B's operations have not been synced. Yjs subdocuments [2] provide manual sync scoping, but the developer must know which subdocuments to load. If entity A's reference to B crosses a subdocument boundary, nothing in the protocol ensures B is loaded.

**Dependency imports.** A document imports entities from a library document (a "dependency"). Local entity A references dependency entity B via a cross-document reference tuple `[uuid, depId]`. If the dependency has not been loaded, the reference is dangling. Automerge acknowledges this: *"You can store the ID in another automerge document, but be aware that Automerge doesn't provide consistency guarantees between documents"* [3].

**Awareness entity resolution.** A peer broadcasts awareness state (cursor position, selection) containing entity references. The receiving peer must resolve those references against its local document. If the referenced entity has not been synced (new entity created by the sender, not yet propagated via the CRDT channel), the awareness reference is transiently dangling.

**Composite key resolution.** A map key is `Set{entityA, entityB}`. Deserializing the key requires resolving both entities. If either is missing, the key is unresolvable — the map entry exists but cannot be accessed.

### 1.2 Why CRDTs Don't Solve This

CRDTs guarantee that the **merge** of any two states is deterministic and commutative. They do not guarantee that a peer's state is **referentially closed** — that every identifier appearing as a reference can be resolved locally.

The standard assumption is **full replication**: every peer has the complete document. Under full replication, referential completeness is trivially satisfied — everything is present. The problem emerges when replication is partial:

- Yjs subdocuments: manually partitioned, no cross-partition reference tracking
- Automerge: one document = one sync unit, cross-document references unmanaged
- Multi-document architectures: each document syncs independently, cross-references are the application's problem

No CRDT framework provides a protocol-level mechanism for ensuring that all entities referenced by the local state are present.

### 1.3 The Opaque Reference Problem

The deeper issue: in existing CRDT frameworks, entity references are **opaque strings.** A UUID stored as a Y.Map value is just a string — the CRDT layer cannot distinguish it from any other string, cannot determine what it references, and cannot check whether the referenced entity exists.

To compute referential completeness, you would need to:
1. Enumerate all references in the document
2. For each reference, determine whether the referenced entity is present

Step 1 requires knowing which strings ARE references — impossible with opaque UUIDs unless the application maintains a separate registry of all reference-bearing fields.

Step 2 requires resolving the reference to a CRDT address — impossible with random UUIDs unless the application maintains a lookup table from UUID to CRDT position.

Both steps require application-managed auxiliary structures that are themselves subject to consistency bugs.

## 2. Self-Resolving References Enable Completeness Checking

With self-resolving entity identity [1], every reference is a decodable pointer into the CRDT operation log. The reference `[uuid]` (or `[uuid, depId]` for cross-document) encodes the creating operation's `{clientId, clock}` pair. Decoding is O(1); resolution is a binary search on the operation log — O(log n).

This transforms referential completeness from an application-level concern into a computable property of the document state.

### 2.1 Reference Enumeration

References in Plexus are structurally identifiable — they are stored as tuples `[uuid]` or `[uuid, depId]` in the Yjs document. The schema defines which fields contain references:

- **Scalar reference fields** (`@syncing accessor ref: Entity | null`) — a single reference tuple
- **Reference lists** (`@syncing.list accessor refs: Entity[]`) — array of reference tuples
- **Child fields** (`@syncing.child accessor child: Entity | null`) — ownership reference
- **Child collections** (`@syncing.child.list`, `@syncing.child.map`) — ownership references
- **Map keys** — may contain entity references (Value, Array, or Set keys with `EntityRef`)
- **Awareness fields** — may contain entity references via `{ "\0": [uuid] }` markers

The schema is known at compile time (declared via decorators). The set of reference-bearing fields is enumerable without runtime introspection.

### 2.2 The Completeness Check

Given a document with a root entity, compute the transitive closure of all references:

```
Algorithm: checkCompleteness(doc, root)
  visited ← {}
  missing ← {}
  queue ← [root.uuid]

  while queue is not empty:
    uuid ← queue.dequeue()
    if uuid in visited: continue
    visited.add(uuid)

    entity ← resolve(doc, uuid)
    if entity is null:
      missing.add(uuid)
      continue

    for each reference ref in enumerateReferences(entity):
      if ref is local [uuid]:
        queue.enqueue(uuid)
      if ref is cross-document [uuid, depId]:
        if depId not loaded:
          missing.add((uuid, depId))
        else:
          queue.enqueue(uuid)  // resolve in dependency doc

  return missing
```

`enumerateReferences(entity)` walks the entity's fields (known from the schema) and collects all reference tuples. For composite map keys, it deserializes the key string and extracts entity references from Value, Array, and Set key constructors [4].

`resolve(doc, uuid)` decodes the self-resolving identifier [1] to `{clientId, clock}`, performs a binary search on the operation log, and returns the entity if present, null if absent.

**Complexity:** O(E + R) where E is the number of entities and R is the total number of references. Each entity is visited once; each reference is checked once. Resolution is O(log n) per reference but dominated by the graph traversal.

### 2.3 Properties

**P1. Computable from the document alone.** The completeness check requires only the document state and the schema. No auxiliary registry, no server query, no cross-peer coordination.

**P2. Detects all classes of missing references.** Local entity references, cross-document dependency references, references in composite map keys, and references in awareness state (by including awareness fields in the enumeration).

**P3. Incremental.** When a new entity is added (via sync or local creation), only its references need to be checked — not the entire graph. When an entity is removed, references TO it from other entities become dangling — detectable by scanning the visited set's references.

**P4. Drives dependency loading.** Cross-document references `[uuid, depId]` where `depId` is not loaded produce a concrete loading specification: "load dependency `depId`." The system can automatically fetch missing dependencies without the application specifying which to load.

## 3. Applications

### 3.1 Automatic Dependency Resolution

A document references entities from three library documents. On load:

1. Parse the document's root entity
2. Walk the reference graph via `checkCompleteness`
3. Discover cross-document references `[uuid, dep1]`, `[uuid, dep2]`, `[uuid, dep3]`
4. Load dependencies `dep1`, `dep2`, `dep3`
5. Re-check completeness (dependencies may reference other dependencies)
6. Iterate until the reference graph is closed

No manifest. No dependency list. The reference graph IS the dependency specification. Adding a reference to a new library entity automatically triggers loading that library on the next completeness check.

### 3.2 Partial Sync with Completeness Guarantee

A large document is split into sections (Yjs subdocuments or equivalent). On loading section A:

1. Sync section A
2. Walk references from A's entities
3. Discover references to entities in sections B and C
4. Load sections B and C (or queue for lazy loading with a "pending" marker)
5. All references from section A are now resolvable

The sync scope is derived from the reference graph, not manually specified. A new cross-section reference added by a peer automatically expands the sync scope on all other peers.

### 3.3 Awareness Completeness

A peer broadcasts awareness state containing entity references (e.g., "my cursor is on entity `pRxK4mN7pQ2wJbL`"). The receiving peer:

1. Decodes the reference
2. Resolves it against the local document
3. If missing: the entity was recently created and hasn't synced yet — mark as "pending resolution"
4. When the entity arrives via CRDT sync, re-resolve the awareness reference

The awareness system naturally handles the race between awareness propagation (fast, lossy) and CRDT sync (slower, reliable). Missing references are transient — they resolve when sync catches up.

### 3.4 Reference Integrity Auditing

Periodically or on-demand, run the completeness check to detect:
- Dangling local references (entity deleted but references remain)
- Unloaded dependencies (cross-document references without loaded dep)
- Orphaned entities (present in CRDT log but not reachable from root)

The audit produces actionable diagnostics: which references are broken, which dependencies need loading, which entities can be pruned.

## 4. The Ownership Tree as Sync Root

The reference graph has a natural root: the document's root entity. But not all entities are reachable via ownership (parent-child) relationships alone. References create additional edges:

```
Ownership edges:  parent → child (tree structure, always reachable)
Reference edges:  entity → referenced entity (graph, may cross ownership boundaries)
Key edges:        map entry → entities in the key (Set/Array keys reference entities)
```

The completeness graph is the union of all three edge types. An entity is "needed" if it is reachable from the root via any combination of ownership, reference, and key edges.

**Orphaned entities** — present in the CRDT log but not reachable via any edge from root — are candidates for cleanup. They consume storage and sync bandwidth but serve no purpose. With self-resolving identity, orphan detection is the complement of the completeness check: entities in the CRDT log whose UUIDs do not appear in the visited set.

This is mark-and-sweep GC for CRDT entities — the root entity is the GC root, the three edge types define reachability, and unreachable entities are garbage. The difference from programming language GC: CRDT GC requires distributed agreement (causal stability [5]) before collecting, because another peer may hold references not yet synced. The completeness check provides the LOCAL reachability signal; distributed agreement determines when it's safe to act on it.

## 5. Constraints

**C1. Schema requirement.** The completeness check requires knowing which fields contain references. In Plexus, this is derived from the decorator-based schema (`@syncing`, `@syncing.child`, `@syncing.list`). Frameworks without a schema (raw Yjs Y.Maps with arbitrary keys) cannot enumerate references without application-level guidance.

**C2. Self-resolving identity prerequisite.** The check depends on references being decodable to CRDT addresses [1]. With opaque UUIDs, resolution requires a lookup table — reintroducing the auxiliary structure the technique eliminates. Automerge objectIds (`"{counter}@{actorId}"`) could serve if the runtime provides O(log n) resolution by objectId.

**C3. Cross-document boundary.** Cross-document references `[uuid, depId]` require loading the dependency document to verify the reference. This creates a potentially recursive loading chain (dep A references dep B references dep C). In practice, dependency graphs are shallow (1-2 levels in the production system), but the check must handle cycles (two documents referencing each other).

**C4. Eventual completeness, not immediate.** In a live system, new entities are created continuously. The completeness check provides a point-in-time snapshot. Between checks, new references may create temporary incompleteness that resolves on the next sync + check cycle.

**C5. Cost of full traversal.** The initial completeness check is O(E + R) — linear in entities and references. For a document with 10,000 entities and 50,000 references, this is a single pass. Incremental maintenance (checking only new/changed entities) reduces steady-state cost.

## 6. Related Work

**Yjs subdocuments** [2] provide sync scoping but no referential completeness checking. The developer manually specifies which subdocuments to load. Cross-subdocument references are the application's responsibility.

**Automerge** [3] explicitly disclaims cross-document consistency: *"Automerge doesn't provide consistency guarantees between documents."* Each document is a self-contained sync unit.

**Kleppmann's replicated tree** [6] uses a TRASH node for deletion semantics — reachability from root determines liveness. This is the closest prior work on tree-based reachability for CRDTs, but addresses deletion (what to remove) rather than sync completeness (what to include).

**Guerreiro's partial replication** [7] formalizes CRDT sharding into "particles" and "shard sets." Objects are decomposed for partial replication. The sharding is defined by the application, not derived from the reference graph.

**GUN.js** [8] implements demand-driven replication — a peer stores only data it has accessed. This is implicit partial sync, but provides no completeness guarantee: a peer may hold entity A that references entity B, but if B was never accessed, it is absent.

**Shapiro et al.** [9] formalize referential integrity under causal consistency, proving that causal consistency suffices to maintain foreign key constraints. Their focus is on preventing dangling references via compensating operations (re-creating deleted referents). Our focus is different: detecting incomplete state rather than preventing it.

**Self-resolving entity identity** [1], **deterministic genesis** [10], and **composite entity-addressed keys** [4] are companion techniques. Self-resolving identity makes references decodable (enabling the check). Genesis ensures structural entities converge (reducing transient incompleteness). Composite keys make entity references in keys enumerable.

## 7. Conclusion

CRDT convergence guarantees that peers agree on state. It does not guarantee that the state they agree on is referentially complete — that every pointer can be resolved, every dependency is loaded, every key can be deserialized.

Self-resolving entity identity transforms this from an application-level bookkeeping problem into a computable document property. The reference graph is enumerable because every reference is decodable. The completeness check is a graph traversal. The result is a concrete specification of what's missing: which entities are absent, which dependencies need loading, which references are dangling.

The reference graph IS the sync specification. Not a manifest, not a dependency file, not an application-managed registry — the document's own references, decoded and traversed.

## References

[1] [companion paper]. "Self-Resolving Entity Identifiers for Operation-Based CRDTs." 2025.

[2] Yjs Subdocuments. docs.yjs.dev/api/subdocuments, 2024.

[3] Automerge. "Modeling Data." automerge.org/docs/cookbook/modeling-data/, 2024.

[4] [companion paper]. "Composite Entity-Addressed Keys for CRDT Maps." 2025.

[5] Shapiro, Preguiça, Baquero, Zawirski. "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA RR-7506, 2011.

[6] Kleppmann, Mulligan, Gomes, Beresford. "A highly-available move operation for replicated trees." IEEE TPDS, 2021.

[7] Guerreiro, Almeida, Baquero. "Conflict-Free Partially Replicated Data Types." IEEE SRDS, 2015.

[8] GUN.js. gun.eco, 2024.

[9] Shapiro, Bieniusa, Zeller, Petri. "Ensuring Referential Integrity Under Causal Consistency." arXiv:1803.03482, 2018.

[10] [companion paper]. "Deterministic Genesis: Coordination-Free Structural Initialization for Operation-Based CRDTs." 2025.
