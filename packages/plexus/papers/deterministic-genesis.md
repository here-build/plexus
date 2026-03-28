# Deterministic Genesis: Coordination-Free Structural Initialization for Operation-Based CRDTs

> Draft — positioned for PaPoC (workshop paper, ~6 pages)

## Abstract

Every CRDT-backed application must establish structural state — containers, schemas, defaults — before user operations can proceed. In decentralized settings, this initialization is a coordination problem: two peers independently creating the same structure produce distinct CRDT operations that conflict rather than converge. We present deterministic genesis, a technique where structural entities are created via content-addressed replica identifiers in throwaway documents, guaranteeing that independent peers produce byte-identical operations under a factory purity assumption. Sync becomes a structural no-op. The technique composes with semantic identifier partitioning [1] and self-resolving entity identity [2] to provide undo invisibility and content-addressed naming for structural entities. Deployed in a production CRDT framework (Plexus/Yjs).

## 1. The Initialization Problem

CRDT-backed collaborative applications require structural state — which we call *scaffold* — before user editing begins. A text editor needs a root paragraph. A design tool needs layer containers. A component system needs type maps and schema containers. We use *genesis* to refer to the deterministic creation of scaffold entities via content-addressed replica identifiers.

In centralized architectures, a server creates scaffold authoritatively. In decentralized, offline-first architectures, there is no authority — and the problem becomes acute.

### 1.1 What Goes Wrong

Consider two peers, Alice and Bob, both opening the same document for the first time while offline.

**Duplication.** Both peers create a root paragraph containing empty text. Each creation is a distinct CRDT operation (different replica identifiers, different Lamport clocks). On sync, the document contains two root paragraphs. The Yjs community documents this directly: *"two people enter a document in an offline state... both their documents are initialized with the initial document value. When one goes online, all good. When the other goes online, this initial document is duplicated"* [3].

**Data loss through structural divergence.** Both peers create a `config` map under the key `"settings"`. Alice writes `config.theme = "dark"`. Bob writes `config.language = "fr"`. On sync, the CRDT resolves the key conflict by selecting one value based on replica identifier ordering — discarding the other map entirely. Alice's `theme` or Bob's `language` is permanently lost. Not because the values conflict, but because the *containers* are distinct CRDT objects despite being semantically identical. The writes targeted different physical maps. The data loss is silent — no error, no conflict marker, no notification.

**Schema evolution deadlock.** Adding a field to a document type requires creating a new container on every existing document. If two peers independently apply the same migration, they produce distinct containers — recreating the duplication problem at the schema level. A Yjs community developer describes this as *"the biggest glaring flaw with Yjs... I'd wager supporting local-first back compat makes dev take 50% longer"* [4].

**Undo corruption.** Scaffold created during initialization is captured by the undo manager alongside user operations. A user pressing Ctrl+Z may inadvertently destroy a schema container or root element — producing an invalid document state. Every major framework addresses this with ad hoc filtering. Yjs uses `trackedOrigins`. Loro uses `excludeOriginPrefixes`. ProseMirror uses `addToHistory: false`. None provides a structural guarantee that scaffold is permanent. Dolan [13] proves that algebraic undo for general CRDTs is impossible beyond counters, making filtering the only option — but every filter is an allowlist maintained by convention, not by the type system.

### 1.2 Existing Workarounds

**Pre-encoded binary templates.** Both Yjs [3] and Automerge [5] arrive at the same recommendation: create the initial state once, serialize to a byte array, and hard-code that array into the application. Every peer applies the identical binary via `Y.applyUpdate()` or `Automerge.load()`. Because the binary is byte-identical across peers, the CRDT deduplicates on merge.

This works for static initial state known at build time. It fails for: per-entity initialization (a new component needs its own containers), schema evolution (new fields added after deployment), and any state that depends on the document's existing content.

**Server-authoritative initialization.** Liveblocks reads `initialStorage` once when a room is first entered; the server ensures single initialization [6]. Figma avoids the problem entirely by using a central server as the authority [7]. Both solutions sacrifice offline-first capability. Liveblocks handles single-initialization but not per-entity initialization, which is the generalization genesis provides.

**The clientID=0 hack.** Yjs community members discovered that temporarily setting `doc.clientID = 0` on all peers before initialization writes makes the operations appear to come from the same source. Kevin Jahns, creator of Yjs, explicitly warns against this: *"THIS CODE IS DISCOURAGED AND WILL LIKELY BREAK YOUR Yjs DOCUMENTS... if you generate complex Y.XML documents like this, the CRDT items will have different types on different peers... the document might get permanently corrupted without a way to recover"* [3].

**Cambria's phantom change.** Ink & Switch's Cambria system [8] generates a deterministic synthetic change with actorId `'0000000000'` to establish default values — the closest prior art to our technique. Cambria treats this as a migration bridge between schema versions, not a CRDT primitive; the phantom change is never persisted or transmitted; and the system was discontinued after Automerge's internal optimizations broke the integration. Genesis makes the mechanism a permanent, persistent, first-class CRDT operation.

**Distributed locks.** Jahns suggests *"consistent hashing by GUID or Redis-redlock"* for guaranteeing single initialization [3]. This requires centralized infrastructure, defeating the purpose of decentralized CRDTs.

### 1.3 The Root Cause

The root cause is a conflation of two distinct concerns:

1. **Structural initialization** — establishing containers, schemas, and scaffold that must exist before user operations.
2. **User content creation** — producing entities that represent a specific peer's intent.

CRDTs handle user content correctly: different peers creating different content *should* produce different entities. But structural initialization has the opposite requirement: different peers creating the *same* structure should produce the *same* entity.

The distinction requires a mechanism that makes initialization operations convergent — not by deduplication after the fact, but by producing physically identical CRDT items regardless of which peer executes the initialization.

## 2. Technique

### 2.1 Content-Addressed Replica Identifiers

Deterministic genesis uses the semantic identifier partitioning scheme [1] to place initialization operations in a dedicated namespace — the genesis range `[3×2^51, 2^53)`. This range has the highest priority in CRDT conflict resolution, ensuring scaffold items are not displaced by concurrent user operations in sequence ordering [1].

Within this range, each structural entity receives a replica identifier derived from a content-addressed hash of its structural position:

```
genesisClientId(type, path) = hash(type, path) mod 2^51 + GENESIS_BASE
```

The hash combines two 32-bit Murmur3 hashes (seeds: `0x47454e`, `0x534953`) into a 51-bit value: 19 bits from the first hash concatenated with 32 bits from the second. `GENESIS_BASE = 3 × 2^51`. Murmur3 is non-cryptographic — chosen for speed, not collision resistance (see C2, C3 for the implications).

The inputs — type name and path within the document tree — are deterministic properties of the structural position. Two independent peers computing the same genesis identifier for the same position get the same value.

### 2.2 Throwaway Document Isolation

Each genesis entity is produced in a throwaway CRDT document:

```
1. Create fresh Y.Doc (tmpDoc)
2. Set tmpDoc.clientID = genesisClientId(type, path)
3. Execute the factory function in tmpDoc
4. Encode: vector = Y.encodeStateAsUpdate(tmpDoc)
5. Destroy tmpDoc
6. Apply: Y.applyUpdate(realDoc, vector)
```

The throwaway document guarantees:

- **Clock = 0.** A fresh document starts its Lamport clock at 0. Every genesis item has clock 0 regardless of the real document's state. (This is a Yjs implementation property, not a CRDT specification guarantee.)
- **No interference.** The factory runs in an empty document — it cannot read or depend on the real document's current state.
- **Binary identity.** Same clientId + clock 0 + same factory output = byte-identical items. Two peers executing the same genesis produce the same binary vector, assuming factory purity (Section 2.4) and deterministic encoding (C7).

Step 6 applies the vector as a remote update (`Y.applyUpdate`). In Yjs, the UndoManager captures only local transactions [12]. Genesis items are therefore architecturally invisible to undo/redo — not filtered, not excluded, but unreachable by the undo mechanism.

When a peer receives genesis items it has already materialized independently, Yjs's YATA algorithm [12] compares incoming items against existing items by `{clientId, clock}` and skips duplicates. Sync is a structural no-op.

### 2.3 Two-Phase Content Addressing

For *virtual children* — entities whose shape depends on a factory function and are materialized lazily on first access — deterministic genesis uses two phases:

**Phase 1: Content hash.** Create a fresh throwaway document with clientId = 0. Run the factory, connect the resulting entity to the throwaway document, encode the state as a binary vector. Hash this vector (32-bit Murmur3). This hash captures the entity's shape.

**Phase 2: Deterministic create.** Compute the genesis clientId from (parent UUID, field name, serialized map key, shape hash from Phase 1). Create a second throwaway document with this clientId. Run the factory again, encode, and apply to the real document.

The two-phase approach is necessary because the genesis clientId must be an input to Phase 2 (it determines the Yjs item identifiers in the encoded vector), but the clientId should depend on the entity's content (to disambiguate structurally different entities at the same position). Phase 1 breaks this chicken-and-egg dependency by computing a content fingerprint first.

The cost is two factory invocations and two throwaway documents per virtual child materialization. Scaffold genesis (document-level containers) uses a single phase because the content is fixed by the schema, not by a factory.

### 2.4 Factory Isolation

Genesis convergence requires that factories are pure functions of their inputs. We partially enforce this with a runtime allowlist: during factory execution, only PlexusModel instances created within the factory are accessible. Accessing any external model throws an invariant violation:

```
genesisAllowlist: Set<Model> | null

assertGenesisIsolation(model):
  if genesisAllowlist is null: return  // not in genesis context (common path)
  if model not in genesisAllowlist: throw "factory isolation violation"
```

The guard catches the most common impurity pattern — reading state from models outside the factory. It does not prevent closure-captured mutable state, `Date.now()`, `Math.random()`, or other ambient non-determinism. Full purity enforcement would require static analysis or a restricted factory DSL, which we leave to future work. In practice, genesis factories are short, declarative functions (typically one `new Entity({...})` call) where impurity is easily auditable.

## 3. Properties

**P1. Convergent under purity.** Two peers executing the same genesis with the same pure factory produce byte-identical CRDT items. Convergence is immediate — no reconciliation needed. This assumes: factory purity (Section 2.4), deterministic Yjs encoding (C7), and Yjs item-level deduplication on `{clientId, clock}` match [12].

**P2. Undo invisible.** Genesis items are applied via `Y.applyUpdate` (remote origin). The UndoManager captures only local transactions [12]. Genesis items are therefore architecturally unreachable by undo — not filtered by an allowlist, but invisible by construction.

**P3. Positional priority.** Genesis clientIds occupy the highest namespace range [1]. In YATA's sequence ordering, when two items share the same causal predecessor, higher clientId wins rightward placement. This ensures scaffold items are not displaced by concurrent user inserts at the same position. Note: for Y.Map key conflicts, Yjs uses a Lamport-clock-based resolution where higher clock wins. User writes to genesis-created map entries (at clock > 0) correctly override the genesis defaults (at clock 0). Priority dominance applies to structural positioning, not to value updates.

**P4. Lazily materializable.** Genesis entities need not exist until accessed. A virtual map can provide an infinite logical keyspace where every key implicitly has a value, materialized on first access via the genesis factory. This realizes Weidner's CRDT-Valued Map pattern [9] with the additional guarantee of convergent *identity* (same UUID across peers) and convergent *priority* (scaffold positioning), beyond the value-convergence that the pattern already provides.

**P5. Content-addressed identity.** Each genesis entity receives a self-resolving identifier [2] with the `d` prefix, encoding the genesis clientId and clock directly. The identifier is deterministic: two peers get the same identifier for the same structural entity. Cross-references to genesis entities are stable, portable, and decodable without a lookup table.

**P6. Additive schema evolution.** Adding a new field to a model type is equivalent to adding a new genesis path. When a peer with the updated schema materializes the new field's container, the genesis items propagate to all peers on sync. Peers on the old schema receive the items and store them inertly — they are Y.Maps the old schema never accesses. Peers on the new schema use them immediately. No migration script, no version negotiation.

This guarantee is limited to *additive* changes (new fields, new paths). Modifications to existing factories (changed default values, renamed fields, altered entity shapes) produce different genesis clientIds on different schema versions, breaking convergence for mixed-version deployments on existing paths. Non-additive schema evolution still requires coordination — Cambria's bidirectional lenses [8] address this complementary problem.

## 4. Applications

### 4.1 Structural Scaffolding

The original motivation. Document-level containers (type maps, field containers, schema registries) are genesis entities. Every peer, on first access, materializes the same containers with the same identities. The containers exist before user operations — not because a server created them, but because the structure is a deterministic consequence of the schema.

### 4.2 Virtual Children (CRDT-Valued Maps)

A model field declared as a virtual map provides an infinite keyspace:

```typescript
@syncing.virtual((key: string) => new Variant({ name: key }))
accessor variants!: VirtualMap<string, Variant>;
```

Accessing `component.variants.get("hover")` materializes a `Variant` entity with the key `"hover"` — if it doesn't already exist. The materialization is deterministic: two peers accessing the same key get the same entity with the same identifier. Subsequent writes to that entity (`variant.opacity = 0.5`) are normal CRDT operations on a shared object — they target the same physical entity and merge correctly.

This eliminates the "create before use" pattern that plagues CRDT applications. There is no "create variant" workflow, no "ensure container exists" check, no race condition. The variant exists the moment it is named.

### 4.3 Offline-First Default Values

The pre-encoded binary template pattern [3, 5] solves static defaults known at build time. Genesis generalizes this to dynamic, per-entity defaults that depend on structural position.

A new document opened offline by any peer materializes its full structural scaffold — type maps, root containers, default configurations — via genesis. The scaffold is identical regardless of which peer opens the document first, second, or never. When peers connect, sync is a structural no-op.

## 5. Constraints

**C1. Factory purity (partially enforced).** Genesis convergence requires that factories are pure functions of their inputs. The runtime guard (Section 2.4) catches PlexusModel field access but cannot prevent closure-captured state, ambient APIs, or non-deterministic JavaScript operations. The two-phase approach (Section 2.3) amplifies this: if a factory produces different output on the second invocation, the content hash from Phase 1 does not match the actual content from Phase 2, creating items with a clientId that does not correspond to their content.

**C2. Hash collision.** The genesis clientId is a 51-bit hash. Birthday collision probability: P ≈ n² / 2^52, where n is the number of distinct genesis paths per document. For n = 10,000: P ≈ 10^8 / 4.5 × 10^15 ≈ 2.2 × 10^-8. At fleet scale (1M documents × 10K paths), expected collisions ≈ 0.02. A collision produces silent corruption: two entities share a clientId, the second materialization is a no-op (Yjs sees the items as already existing), and the second entity never appears. Murmur3 provides no resistance against targeted collisions — an adversary who controls factory inputs can craft collisions in sub-second time.

**C3. Content hash intermediate.** The shape hash in two-phase content addressing (Section 2.3) is 32-bit Murmur3, with a birthday bound of ~65K entities before 50% collision probability. This is the bottleneck for large schemas. Widening to 64-bit (two Murmur3 calls) would raise the bound to ~4 billion.

**C4. Tombstone interaction.** If a genesis entity is created, then deleted (tombstoned), and another peer independently materializes the same genesis entity, the incoming items match the tombstoned items' `{clientId, clock}` and remain deleted. Genesis guarantees convergent creation but does not override prior deletions. Genesis is not idempotent in the presence of tombstones.

**C5. Cooperative deployment.** Genesis assumes all peers use the same factory for the same structural position. A peer using a different factory produces different genesis items — breaking convergence for that path. Because genesis is deterministic, a server-side relay can enforce this by independently computing the expected genesis clientId for each structural position and rejecting updates with mismatched identifiers. The server does not need to trust the peer — it verifies by recomputation.

**C6. State vector inflation.** Each unique genesis clientId adds an entry to the document's state vector (Yjs's compact summary of per-client operation counts). A document with 10K genesis paths has 10K state vector entries. This inflates sync handshake payloads proportionally.

**C7. Yjs-specific assumptions.** The implementation depends on: (a) item-level deduplication when applying updates with identical `{clientId, clock}` pairs [12], (b) UndoManager ignoring remote-origin updates [12], (c) deterministic binary encoding of document state via `Y.encodeStateAsUpdate`, (d) mutable `clientID` property on Y.Doc (Automerge does not allow changing actorId after document creation), (e) Lamport clock starting at 0 for fresh documents. The general principle — content-addressed replica identifiers for structural operations — is portable to any operation-based CRDT with item deduplication. The specific implementation assumes Yjs's YATA algorithm.

## 6. Related Work

**Cambria** [8] is the closest prior art. Its "phantom change" mechanism is structurally similar to genesis. Genesis makes the mechanism permanent and persistent. However, Cambria provides a capability genesis does not: bidirectional lenses that *transform* data between schema versions. Genesis handles convergent initialization (additive evolution) but has no story for schema transformation (renames, type changes). The two approaches are complementary — if Cambria were revived with genesis as its initialization primitive, the phantom change fragility that limited the original implementation would be eliminated.

**Weidner's CRDT-Valued Map** [9] formalizes the lazy-materialization pattern: *"every key/value pair is implicitly always present in the map, but values are only explicitly constructed in memory as needed, using a predefined factory method."* Weidner's pattern already implies value-convergence (the factory produces CRDTs, and CRDTs converge). Genesis adds *identity*-convergence (same identifier across peers), positional priority (scaffold items cannot be displaced), and undo invisibility — properties beyond the pattern's formalization.

**EVM CREATE2** [10] provides a useful analogy. A smart contract's address is derived from `hash(deployer, salt, bytecode)`, enabling counterfactual interaction with an address before the contract exists. Genesis derives an entity's identity from `hash(parent, field, key, shape)`, enabling independent peers to write to an entity before it is materialized. The correspondence is structural, not exact: CREATE2 produces immutable bytecode, while genesis entities are mutable CRDT objects whose content evolves after creation.

**Yjs pre-encoded templates** [3] and **Automerge hard-coded byte arrays** [5] are the production workarounds for deterministic initialization. Both require build-time knowledge of the initial state and cannot handle per-entity or schema-evolution scenarios. Genesis generalizes the pattern: every structural position has its own deterministic "template" computed at runtime from the schema.

**Semantic identifier partitioning** [1] provides the namespace that makes genesis items structurally distinct from user operations. Self-resolving entity identifiers [2] provide the `d`-prefix encoding that makes genesis entities addressable and cross-referenceable.

**DXOS ECHO Epochs** [11] address schema migration through periodic "new beginnings" that compact history. Unlike genesis, Epochs require coordination (only one of two concurrent epoch creations survives) and operate at document granularity, not per-entity.

**Merkle-CRDTs** [14] use content-addressed hashing for operation deduplication — hashing operation bytes, not the semantic content of created entities. Genesis uses content-addressing at a different level: deriving entity *identity* from structural position, enabling convergent creation rather than deduplication of existing operations.

## 7. Conclusion

The initialization problem in decentralized CRDTs is not a minor inconvenience — it is a structural deficiency that every production system works around with ad hoc patterns, each with known failure modes. The root cause is that CRDTs treat structural initialization and user content creation as the same operation, when they have fundamentally different convergence requirements.

Deterministic genesis resolves this by giving structural operations their own identity mechanism: content-addressed replica identifiers that produce byte-identical CRDT items regardless of which peer executes the initialization. The technique converts "ensure X exists" from a coordination problem into a pure computation.

The costs are real: factory purity is partially enforced, the technique is Yjs-specific in its current form, state vectors inflate with genesis path count, and non-additive schema changes still require coordination. The benefits are structural: initialization cannot be undone, cannot race, cannot duplicate, and converges without communication.

The CRDT already provides convergent *content*. Genesis extends the guarantee to convergent *structure*.

## References

[1] [companion paper]. "Semantic Partitioning of Replica Identifiers for Priority-Ordered CRDT Conflict Resolution." 2025.

[2] [companion paper]. "Self-Resolving Entity Identifiers for Operation-Based CRDTs." 2025.

[3] Yjs Community Forum. "Initial offline value of a shared document." discuss.yjs.dev, 2021. (Kevin Jahns, dmonad)

[4] Yjs Community Forum. "What is the correct way to apply document migrations?" discuss.yjs.dev, 2024. (Braden)

[5] Automerge. "Modeling Data — Schema Changes." automerge.org/docs/cookbook/modeling-data/, 2024.

[6] Liveblocks. "Setting an initial or default value in BlockNote." liveblocks.io/docs/guides/, 2024.

[7] Wallace. "How Figma's multiplayer technology works." figma.com/blog, 2019.

[8] Litt, van Hardenberg, Henry. "Cambria: Schema Evolution in Distributed Systems with Edit Lenses." PaPoC, ACM, 2021.

[9] Weidner. "Designing Data Structures for Collaborative Apps." mattweidner.com, 2022.

[10] Buterin. "EIP-1014: Skinny CREATE2." Ethereum Improvement Proposals, 2018.

[11] DXOS. "Decentralized schema changes and data migrations." blog.dxos.org, 2024.

[12] Nicolaescu, Jahns, Derntl, Klamma. "Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types." ACM GROUP, 2016.

[13] Dolan. "The Only Undoable CRDTs are Counters." arXiv:2006.10494, 2020.

[14] Sanjuán, Pöyhtäri, Teixeira. "Merkle-CRDTs: Merkle-DAGs meet CRDTs." Protocol Labs, 2020.
