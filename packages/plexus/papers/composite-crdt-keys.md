# Composite Entity-Addressed Keys for CRDT Maps

> Draft — positioned for PaPoC (short paper, ~4 pages)

## Abstract

CRDT maps restrict keys to strings — a constraint inherited from JSON, not from CRDT algebra. We present a key serialization algebra that embeds primitives, entity references, ordered tuples, and unordered sets into string keys with deterministic cross-peer serialization. Set keys are sorted after serialization, making `{A, B}` and `{B, A}` identical across peers. With self-resolving entity identity [1], entity references in keys are decodable back to the CRDT operation log without a lookup table. The technique enables CRDT-native composite key addressing: junction-free relations and multi-dimensional lookups expressed as single map entries, without application-managed indexes.

## 1. The String Key Constraint

Every major CRDT map implementation restricts keys to strings:

| Framework | Key type | Source |
|-----------|----------|--------|
| Yjs Y.Map | `string` | Hard-coded in API [3] |
| Automerge | `string` | JSON object model [4] |
| Loro | `string` | Hard-coded in API [5] |

This restriction inherits from the JSON data model: JSON object keys are strings. CRDT frameworks that model "JSON-like documents" inherit the constraint. Notably, the CRDT algebra itself imposes no such restriction — standard formalizations of OR-Map and LWW-Map parameterize over a key set K with no structural requirement beyond equality [6, 7]. The string constraint is a convention, not a necessity.

The one production exception is Riak DT Map [8], which uses composite keys `(name: binary, type: atom)` where `type` is one of `{counter, set, register, flag, map}` — a fixed schema-level discriminator that distinguishes "score as counter" from "score as set," not an arbitrary composite key.

### 1.1 What String Keys Cannot Express

**Entity-keyed lookups.** A design tool stores style overrides per component. The natural key is the component entity. With string keys, the application must serialize the entity's ID to a string, handle key stability, and resolve keys back to entities via a lookup table or secondary index.

**Composite relationships.** A collaborative spreadsheet applies conditional formatting rules per cell. The natural key is the tuple `(row, column, rule)` — three entity references. String keys require an ad hoc serialization convention (`"${rowId}::${colId}::${ruleId}"`) that every consumer must implement identically.

**Multi-ownership via set keys.** A visual component has style settings per *combination* of active variants — what does it look like when both `hover` and `disabled` are active? The natural key is the unordered set `{hover, disabled}`. String keys require sorting entity IDs, choosing a delimiter, and ensuring all peers use the same convention. The industry workaround is exactly this: `JSON.stringify(combo.map(v => v.uuid).sort())`.

**Junction-free relations.** Many-to-many relationships in relational databases use junction tables with composite primary keys. In CRDTs, this requires either a junction entity (doubling the operation count) or a manually-serialized composite string key.

The universal pattern across frameworks: `Map<string_serialized_id, Data>`, with secondary indexes built outside the CRDT [4]. Loro explicitly advises against using CRDTs for *"global invariants (referential integrity, cross-document totals)"* [5]. Our technique does not enforce global invariants — it expresses structural relationships that converge by construction, which is a different concern.

## 2. Technique

The key serialization algebra is a layer above the CRDT map, not a modification to it. Composite keys serialize to plain strings and store in any existing string-keyed CRDT map. The CRDT's conflict resolution semantics are unchanged.

### 2.1 Key Type Algebra

Three constructors over a value domain:

```
Key ::= Value(v)                      -- single value
       | Array(v₁, v₂, ..., vₙ)      -- ordered composite (n ≥ 0)
       | Set(v₁, v₂, ..., vₙ)        -- unordered composite (n ≥ 0, no duplicates)

v   ::= string | number | boolean | bigint | null | EntityRef(id)
```

`EntityRef(id)` is a reference to a CRDT entity, where `id` is the entity's self-resolving identifier [1] — a 15-character string encoding the creating operation's `{clientId, clock}` pair. Nesting is not supported: keys cannot contain other keys as elements.

The constructors form a tagged union. The type tag (`Value`, `Array`, `Set`) is part of the serialized form, ensuring that `Value(42)` and `Array(42)` are distinct keys.

Empty containers are valid: `Set()` represents "no entities" (e.g., base variant with no active states), `Array()` represents an empty tuple.

### 2.2 Serialization

Keys serialize to newline-delimited strings with a type prefix:

```
Value key:    "Value\n" + serializeValue(v)
Array key:    "Array\n" + serializeValue(v₁) + "\n" + ... + "\n" + serializeValue(vₙ)
Set key:      "Set\n"   + sort([serializeValue(v₁), ..., serializeValue(vₙ)]).join("\n")
```

**Value serialization.** Primitives serialize via `JSON.stringify`, which escapes newlines to `\\n` — ensuring the newline delimiter is unambiguous. Special cases handled explicitly: `NaN` → `"NaN"`, `Infinity` → `"Infinity"`, `-Infinity` → `"-Infinity"`, bigints via trailing `n` suffix (`42n`). Entity references serialize to their CRDT reference tuple: `["pRxK4mN7pQ2wJbL"]` for local entities, `["pRxK4mN7pQ2wJbL", "dep123"]` for cross-document references.

**Set commutativity.** Set elements are serialized individually, then sorted lexicographically as strings. This produces identical key strings regardless of insertion order, without requiring a total order on the heterogeneous value domain. The sort operates on serialized forms (byte strings), which always have a total order.

**Injectivity.** The serialization is injective (distinct keys produce distinct strings) under the following conditions: (a) `JSON.stringify` is injective for the supported primitive types — which holds except for `-0` vs `0` (both produce `"0"`), and numbers beyond `Number.MAX_SAFE_INTEGER` (precision loss). These edge cases should be validated at the serialization boundary. (b) Entity identifiers are unique per the CRDT's own guarantee [1]. (c) The type prefix and newline delimiter are unambiguous (JSON-encoded strings cannot contain literal newlines).

### 2.3 Resolution

Deserialization splits on newlines, reads the type prefix, and resolves each element. Entity references are decoded from the self-resolving identifier to `{clientId, clock}`, then resolved via binary search on the CRDT operation log [1]. Resolution is O(log m) per entity reference, where m is the operation count for the relevant client — with no auxiliary index or lookup table.

## 3. Properties

### 3.1 Standalone (no companion dependencies)

**P1. Cross-peer determinism.** Two peers serializing the same key produce the same string. Set keys are order-independent by construction (sort-after-serialize). This holds for any CRDT map that accepts string keys.

**P2. Collision-free under supported types.** Distinct keys produce distinct serialized strings, given: supported primitive types (excluding `-0` and unsafe integers), unique entity identifiers, and the tagged-union type prefix.

**P3. Framework-compatible.** The serialized key is a plain string. It stores in Yjs Y.Map, Automerge maps, Loro maps, or any string-keyed CRDT map without protocol changes. Frameworks with aggressive key interning or columnar compression may see disproportionate performance impact from long composite keys.

### 3.2 Composed (with self-resolving entity identity [1])

**P4. Decodable keys.** With self-resolving entity identity [1], every entity reference in a key can be resolved to a live entity via decode + binary search on the CRDT operation log. No lookup table or secondary index required. A serialized key received over any channel (network, clipboard, snapshot) is self-contained — every entity reference is a live pointer.

**P5. Stable entity references.** Entity identifiers are derived from the creating operation's coordinates [1] and never change. A key referencing entity A remains valid regardless of how A's content evolves. This is structurally stronger than using mutable properties (names, paths) as key components.

Note: when combined with deterministic genesis [2] and semantic identifier partitioning [3], structural entities referenced in keys gain additional properties — convergent creation and priority ordering — but these are contributions of the companion papers, not of the key algebra itself.

## 4. Applications

### 4.1 Entity-Keyed Lookups

The simplest case — one entity as a map key:

```
Map<Component, StyleOverride>
```

The component's self-resolving identifier serves as the key. Stable across peers, survives serialization, resolves without a registry.

### 4.2 Composite Relationships (Tuples)

Two entities jointly own a configuration:

```
Map<[Component, Slot], Binding>
```

The array key is an ordered composite — `[A, B]` ≠ `[B, A]`. No junction entity needed. The key IS the relation.

### 4.3 Multi-Dimensional Lookups (Sets)

A visual component has style settings per variant combination:

```
Map<Set<Variant>, StyleSettings>
```

The set key `{hover, disabled}` serializes identically regardless of insertion order. This eliminates the ad hoc `JSON.stringify(combo.map(v => v.uuid).sort())` pattern found in production Yjs applications. Two peers writing style settings for the same variant combination address the same map entry — their writes merge correctly via the underlying CRDT's per-key conflict resolution.

Note: set-keyed maps provide exact-match lookups. Range queries ("find all entries whose key is a subset of this set") require additional application logic or a secondary index.

### 4.4 Hyperedges

A hyperedge connects N nodes. The edge identity is the set of connected nodes:

```
Map<Set<Node>, EdgeData>
```

No separate edge entity. The edge exists because the set of nodes was addressed. Two peers creating an edge between the same nodes produce the same set key — the edge converges without coordination.

## 5. Constraints

**C1. Dangling references and referential GC.** When a referenced entity is deleted, keys containing it become partially unresolvable. This mirrors the dangling foreign key problem in relational databases. However, because entity references in keys are decodable (not opaque strings), referential garbage collection becomes possible: when entity A is deleted, its identifier can be matched against serialized map keys to find all entries referencing A, enabling cascade deletion or tombstoning without an application-managed reverse index. With opaque string keys, this would require maintaining a separate lookup structure; with self-resolving keys, the reference is structurally visible in the key string itself.

**C2. Set key cardinality.** A set of N entities produces a key string of approximately N × 17 characters (15-char identifier + delimiters). CRDT maps store the full key string per entry. High-cardinality sets (100+ elements) inflate storage and sync payloads. A content-addressed hash of the sorted set would be more compact at the cost of losing decodability.

**C3. Primitive edge cases.** `-0` and `0` serialize identically via `JSON.stringify`. Numbers beyond `Number.MAX_SAFE_INTEGER` lose precision during serialization. The serialization boundary should validate these cases. BigInt serialization uses an unquoted `n` suffix, distinguished from string `"42n"` by the JSON quotes around the string form.

**C4. Garbage collection interaction.** The technique requires `gc: false` in Yjs [1] to ensure referenced entities are retained. With GC enabled, entity references in keys become dangling when operations are collected. Three interaction modes exist: (a) `gc: false` — everything works; (b) GC with reference scanning — on entity deletion, scan map keys for references to the deleted entity and cascade-delete the entries (feasible because keys are decodable, not opaque); (c) GC without reference scanning — dangling keys are inevitable, application must tolerate partial resolution.

**C5. Portability.** The key serialization algebra (P1-P3) works with any CRDT framework using its native entity identifiers — Automerge objectIds (`"{counter}@{actorId}"`), Loro TreeIds, or application-generated UUIDs. With Automerge objectIds, entity-keyed lookups already work (objectIds are resolvable via `doc.getObjectById()`). The decodability property (P4) specifically requires self-resolving identifiers [1] but the algebra itself does not.

## 6. Related Work

**Riak DT Map** [8] is the only CRDT with composite keys in production. Its `(name, type)` pair is a fixed schema discriminator — our algebra generalizes from fixed discriminators to arbitrary entity references, ordered tuples, and unordered sets.

**Kleppmann and Beresford** [9] formalize JSON CRDTs with string-keyed maps, establishing the convention this paper extends. Their concurrent map-key assignment semantics (LWW per key) apply unchanged to composite keys — the serialized string is the LWW unit.

**Baquero, Almeida, and Shoker** [6] define pure operation-based CRDTs with generic key types, demonstrating that the CRDT algebra does not require string keys. Our technique bridges this theoretical generality with the practical string-key constraint of deployed frameworks.

**SynQL** [10] replicates relational foreign keys as string attributes — the "serialize entity ID to string" pattern. It does not support composite or set-valued keys.

**Shapiro et al.** [11] prove that causal consistency suffices for referential integrity. Our entity references in keys are not enforced by the CRDT — they are structural relationships expressed through serialization, not integrity constraints.

**Weidner's CRDT-Valued Map** [12] formalizes lazy maps where every key implicitly has a value. With set keys, the logical keyspace is the powerset of the entity space — every possible combination of entities becomes a valid key.

**Self-resolving entity identity** [1] is the primary companion technique — it provides the decodable, cross-peer-stable entity references that make entity-addressed keys possible. Deterministic genesis [2] and semantic identifier partitioning [3] provide additional guarantees (convergent creation, priority ordering) for structural entities but are not required by the key algebra itself.

## 7. Conclusion

CRDT maps have been string-keyed since their formalization. The CRDT algebra imposes no such restriction — it is inherited from the JSON data model. We provide a structured serialization that embeds richer key types into strings while preserving the properties needed for correct CRDT convergence.

The core contribution — a key type algebra with entity references, ordered tuples, and unordered sets — is adoptable by any CRDT framework with string-keyed maps. With self-resolving entity identity [1], keys become decodable pointers — every entity reference in a key resolves directly to the CRDT operation log. The result eliminates junction entities, ad hoc key serialization, and the assumption that map keys must be opaque strings.

Just a serialization algebra that makes the string key carry structural information it was never designed to hold.

## References

[1] [companion paper]. "Self-Resolving Entity Identifiers for Operation-Based CRDTs." 2025.

[2] [companion paper]. "Deterministic Genesis: Coordination-Free Structural Initialization for Operation-Based CRDTs." 2025.

[3] [companion paper]. "Semantic Partitioning of Replica Identifiers for Priority-Ordered CRDT Conflict Resolution." 2025.

[4] Automerge. "Modeling Data." automerge.org/docs/cookbook/modeling-data/, 2024.

[5] Loro. "When Not to Use CRDTs." loro.dev/docs/concepts/when_not_crdt, 2024.

[6] Baquero, Almeida, Shoker. "Pure Operation-Based Replicated Data Types." arXiv:1710.04469, 2017.

[7] Shapiro, Preguiça, Baquero, Zawirski. "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA RR-7506, 2011.

[8] Brown, Cribbs, Meiklejohn, Elliott. "Riak DT map: a composable, convergent replicated dictionary." PaPEC, ACM, 2014.

[9] Kleppmann, Beresford. "A Conflict-Free Replicated JSON Datatype." IEEE TPDS, 2017.

[10] Ignat, Elvinger, Ba. "Synql: A CRDT-Based Approach for Replicated Relational Databases with Integrity Constraints." DAIS, 2024.

[11] Shapiro, Bieniusa, Zeller, Petri. "Ensuring Referential Integrity Under Causal Consistency." arXiv:1803.03482, 2018.

[12] Weidner. "Designing Data Structures for Collaborative Apps." mattweidner.com, 2022.
