# Referential Completeness Checking for Partially Replicated CRDTs via Self-Resolving References

> Draft — positioned for PaPoC or Local-First Conference (workshop paper, ~5 pages)

## Abstract

CRDTs guarantee convergence — peers that exchange updates reach identical state. They do not guarantee referential completeness — that every entity reference in a partial replica can be resolved locally. We observe that self-resolving entity identity (where references encode CRDT operation coordinates [1]) makes completeness a checkable predicate: the reference graph is enumerable because every reference is decodable. The check is a graph traversal over document state and schema, producing a concrete specification of missing entities and unloaded dependencies. This enables CRDT documents to be self-specifying for partial replication — the sync scope is derivable from document state, without external manifests.

## 1. Convergence Is Not Completeness

CRDTs provide a strong guarantee: **convergence.** Two peers that exchange all their updates reach identical state. This is the foundation of coordination-free collaboration.

Convergence says nothing about **completeness.** A peer may converge on a consistent state that contains dangling references — pointers to entities that exist on other peers but have not been synced locally. The CRDT is consistent (all received updates are integrated), but the application cannot resolve its own references.

Under full replication (every peer has the entire document), completeness is trivially satisfied. The problem emerges under partial replication — and partial replication is where CRDTs are heading: Yjs subdocuments [2], multi-document architectures, dependency imports across projects, and demand-driven loading.

### 1.1 Where Incompleteness Arises

**Partial sync.** A large document loads incrementally — the current page first, other pages on demand. Entity A on the current page references entity B on an unloaded page. The reference is in the CRDT state, but B's operations have not been synced.

**Dependency imports.** A document imports entities from a library document via cross-document reference tuples `[uuid, depId]`. If the dependency has not been loaded, the reference is unresolvable. Automerge explicitly disclaims this: *"Automerge doesn't provide consistency guarantees between documents"* [3].

**Composite key resolution.** A map key is `Set{entityA, entityB}` [4]. Deserializing the key requires resolving both entities. If either is missing, the map entry is inaccessible.

### 1.2 Why CRDTs Cannot Check This Today

The deeper issue: in existing frameworks, entity references are **opaque strings.** A UUID stored as a Y.Map value is indistinguishable from any other string. The CRDT layer cannot enumerate references (which strings are entity pointers?) or resolve them (does this entity exist locally?).

Computing completeness requires two capabilities:
1. **Enumerate** all references in the document — which fields contain entity pointers?
2. **Resolve** each reference — does the referenced entity exist in the local state?

With opaque identifiers, both require application-managed auxiliary structures: a registry of reference-bearing fields and a lookup table from UUID to CRDT position. These structures are themselves subject to consistency bugs and must be maintained manually.

Self-resolving entity identity [1] eliminates the resolution problem: every reference encodes the creating operation's `{clientId, clock}` pair, decodable to a CRDT address without any lookup table. A schema (which fields are references) eliminates the enumeration problem. Together, they make completeness checkable from document state and schema alone.

## 2. The Completeness Check

### 2.1 Self-Resolving Identity (Summary)

A self-resolving identifier [1] is a compact string (15 characters in the Plexus implementation) encoding a CRDT operation's `{clientId, clock}` pair. Given the operation log, any peer can decode the identifier and resolve it via binary search — O(log m) where m is the operation count for the relevant client. No lookup table, no registry, no auxiliary index.

For cross-document references, the identifier is extended to a tuple `[uuid, depId]` where `depId` routes to the dependency document.

### 2.2 Reference Enumeration via Schema

The schema declares which fields contain entity references. In Plexus, this is determined by decorator annotations:

| Decorator | Reference type | Traversal |
|-----------|---------------|-----------|
| `@syncing accessor ref: Entity` | Scalar reference | Single tuple |
| `@syncing.list accessor refs: Entity[]` | Reference list | Array of tuples |
| `@syncing.child accessor child: Entity` | Ownership reference | Single tuple |
| `@syncing.child.list` / `.map` / `.set` | Ownership collections | Collection of tuples |
| Map keys with `EntityRef` [4] | Key-embedded references | Deserialize key, extract refs |

The set of reference-bearing fields is known at compile time. No runtime introspection needed.

**Schema coverage caveat.** The check is sound (no false negatives) only when the schema covers all reference-bearing fields. User-extensible metadata or untyped plugin data may contain references invisible to the schema. At less than full coverage, the check provides a lower bound on completeness.

### 2.3 Algorithm

Given a document, its schema, and a root entity, compute the set of missing references:

```
checkCompleteness(doc, schema, root):
  visited ← {}
  missing ← {}
  queue ← [root.uuid]

  while queue is not empty:
    id ← queue.dequeue()
    if id in visited: continue
    visited.add(id)

    entity ← resolve(doc, id)
    if entity is null:
      missing.add(id)
      continue

    for each ref in enumerateReferences(entity, schema):
      if ref is local [refId]:
        queue.enqueue(refId)
      if ref is cross-document [refId, depId]:
        if depId not loaded:
          missing.add((refId, depId))
        else:
          queue.enqueue(refId)  // resolve in dependency's doc

  return missing
```

`enumerateReferences(entity, schema)` walks the entity's schema-declared fields and collects all reference tuples. For composite map keys [4], it deserializes the key string and extracts entity references from Value, Array, and Set key constructors.

**Complexity.** O((E + R) × log m) where E is entity count, R is total reference count, and m is the per-client operation count for resolution. The log factor comes from binary search resolution per reference. For cross-document references resolved against in-memory dependency maps, resolution is O(1).

**Cycle handling.** The `visited` set prevents re-traversal of entities in cyclic reference graphs. For cross-document cycles (doc A references doc B, B references A), the algorithm requires tracking loaded documents to prevent re-loading — maintain a `loadedDocs` set alongside `visited`.

### 2.4 Properties

**P1. Checkable from document state and schema.** No auxiliary runtime registry, no server query, no cross-peer coordination. The schema is a compile-time artifact, not a runtime structure.

**P2. Produces a loading specification.** Missing local references identify absent entities. Missing cross-document references identify unloaded dependencies (`depId`). The output is actionable: load these dependencies, sync these entities.

**P3. Incremental on entity creation.** When a new entity arrives via sync, check only its references — not the full graph. O(refs_per_entity × log m) per entity. Full re-traversal is needed only for deletion detection (which entities are no longer referenced) or periodic auditing.

Note: detecting newly-dangling references on entity deletion requires maintaining an inverse reference index — which is an auxiliary structure. The incremental property holds for additions; deletions require either re-traversal or an inverted index.

## 3. Applications

### 3.1 Dependency Loading Without Manifests

A document references entities from library documents. On load:

1. Walk the reference graph from root via `checkCompleteness`
2. Collect missing `(refId, depId)` tuples
3. Load dependencies for each missing `depId`
4. Re-check (dependencies may reference transitive dependencies)
5. Repeat until the reference graph is closed or all missing deps are unavailable

The reference graph produces the **loading specification** — which dependencies are needed. A separate **resolution service** (mapping `depId` to a fetchable blob) is still required. The contribution is making the specification derivable from the document rather than manually maintained in a manifest.

**Cycle termination.** Circular dependencies (doc A ↔ doc B) terminate because the `visited` set prevents re-traversal of already-checked entities. The loading loop tracks `loadedDocs` to avoid re-fetching.

### 3.2 Partial Sync Scope Derivation

A large document is split into sections (Yjs subdocuments or equivalent). Loading section A:

1. Sync section A
2. Walk references from A's entities
3. Discover references to entities in sections B and C
4. Load B and C (or queue for lazy loading with a "pending" marker)

The sync scope is derived from the reference graph, not manually specified. A cross-section reference added by a peer automatically expands the sync scope on all other peers at next check.

### 3.3 Reachability-Based Cleanup

The completeness check's visited set is the **live set** — entities reachable from root via any combination of ownership, reference, and key edges. Entities in the CRDT log but not in the visited set are **orphans** — candidates for cleanup.

This is the mark phase of mark-and-sweep GC applied to CRDT entities. The root entity is the GC root. The three edge types (ownership, reference, key) define reachability.

**Critical limitation:** acting on the local reachability signal requires distributed agreement — another peer may hold references to entities that appear locally unreachable. Causal stability [5] determines when it is safe to collect. We leave the distributed agreement protocol for future work; here we establish only the local reachability signal.

## 4. Constraints

**C1. Schema requirement.** The check requires knowing which fields contain references. Systems with complete schemas (Plexus decorators, TypeScript-typed Automerge) satisfy this. Schema-free CRDT usage (raw Y.Maps with arbitrary keys) cannot enumerate references without application guidance.

**C2. Self-resolving identity for cross-document.** Intra-document completeness works with any resolvable reference format — Automerge objectIds suffice (Automerge can resolve any objectId via its internal document state). Cross-document completeness requires references that encode their document of origin — the `[uuid, depId]` pattern or equivalent.

**C3. Resolution service.** The check produces a loading specification (which `depId`s are needed). Fetching the actual dependency data requires a resolution service — an API, a peer-to-peer protocol, or a local cache. The check does not provide this service.

**C4. Eventual, not immediate.** In a live system, new references are created continuously. The check provides a point-in-time snapshot. Between checks, new references may create temporary incompleteness that resolves on the next sync + check cycle.

**C5. Schema evolution.** If a new schema version adds a reference field that the old version didn't have, a check running the old schema misses those references. Completeness checking is sound only for the schema version it was run with.

**C6. Cost of GC.** The reachability-based cleanup (Section 3.3) depends on distributed agreement before acting. Without a causal stability protocol, orphan detection is informational only — it cannot safely trigger deletion.

## 5. Related Work

**Shapiro et al.** [6] formalize referential integrity under causal consistency — preventing dangling references via compensating operations. Referential integrity is a write-time constraint (prevent violations). Referential completeness is a read-time property of partial replicas (detect incompleteness). The two are orthogonal — integrity prevents broken references from being created; completeness detects missing entities from incomplete sync.

**Kleppmann's replicated tree** [7] uses a TRASH node for deletion semantics — tree reachability determines liveness. This addresses deletion (what to remove) via causal stability, not sync completeness (what to include via reference traversal).

**Guerreiro et al.** [8] formalize CRDT partial replication by decomposing objects into "particles" and "shard sets" with per-object causal metadata. Their sharding is application-specified, not reference-derived. Their formalization of per-shard consistency properties is more rigorous than this paper's operational approach; we address a complementary concern (deriving the shard specification from the reference graph).

**Yjs subdocuments** [2] provide sync scoping at document granularity. No cross-subdocument reference tracking. The developer manually specifies which subdocuments to load.

**Automerge** [3] treats each document as a self-contained sync unit. Cross-document references are unmanaged. Automerge objectIds could support intra-document completeness checking without self-resolving identity.

**Module bundlers** (webpack, esbuild) derive build specifications from import graphs. **Package managers** (apt, npm) derive install specifications from dependency graphs. The general principle — follow references, fetch what's missing — is well-established. The CRDT-specific contribution is that the references are embedded in mutable, replicated state and change during sync, and that self-resolving identity makes them enumerable without auxiliary metadata.

**Self-resolving entity identity** [1] and **composite entity-addressed keys** [4] are companion techniques. Self-resolving identity makes references decodable (enabling the check). Composite keys make entity references in map keys enumerable.

## 6. Conclusion

CRDTs guarantee that peers agree on state. They do not guarantee that the state is referentially complete — that every pointer resolves, every dependency is loaded, every composite key can be deserialized.

Self-resolving entity identity makes this gap checkable. The reference graph is enumerable because every reference is decodable. The check is a graph traversal. The output is a loading specification — which entities are absent, which dependencies need fetching.

The enablement is the contribution, not the traversal. Any system with decodable references and a schema can compute referential completeness. Self-resolving CRDT identity [1] provides the decodability. The schema provides the enumeration. Together, they make CRDT documents self-specifying for partial replication — the sync scope derivable from document state, without external manifests.

## References

[1] [companion paper]. "Self-Resolving Entity Identifiers for Operation-Based CRDTs." 2025.

[2] Yjs Subdocuments. docs.yjs.dev/api/subdocuments, 2024.

[3] Automerge. "Modeling Data." automerge.org/docs/cookbook/modeling-data/, 2024.

[4] [companion paper]. "Composite Entity-Addressed Keys for CRDT Maps." 2025.

[5] Shapiro, Preguiça, Baquero, Zawirski. "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA RR-7506, 2011.

[6] Shapiro, Bieniusa, Zeller, Petri. "Ensuring Referential Integrity Under Causal Consistency." arXiv:1803.03482, 2018.

[7] Kleppmann, Mulligan, Gomes, Beresford. "A highly-available move operation for replicated trees." IEEE TPDS, 2021.

[8] Guerreiro, Almeida, Baquero. "Conflict-Free Partially Replicated Data Types." IEEE SRDS, 2015.
