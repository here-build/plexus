# Semantic ClientId Partitioning: Priority-Ordered Conflict Resolution in CRDTs

> Draft — positioned for PaPoC (workshop paper, ~4 pages)

## Abstract

Conflict-free Replicated Data Types resolve concurrent writes using a total order derived from replica identifiers. All existing formalizations treat these identifiers as opaque — their only semantic property is uniqueness. We observe that partitioning the identifier space into priority-ordered ranges transforms the conflict resolution tiebreaker from an arbitrary per-replica decision into a deterministic per-category guarantee. We demonstrate the technique in a production CRDT system (Plexus/Yjs) with four identifier ranges: regular operations, ephemeral sessions, committed ephemeral, and deterministic scaffold — where the range encodes the operation's lifecycle stage and structural role, not its authorship.

## 1. Background

CRDT conflict resolution requires a total order over concurrent operations. In operation-based CRDTs (CmRDTs), this typically involves comparing replica identifiers when operations share the same causal predecessor. The YATA algorithm [1], used in Yjs, resolves positional conflicts in sequences by comparing `clientId` values: higher clientId wins when two items have the same origin.

The standard assumption: clientIds are random unique integers. The resolution is deterministic (always the same winner) but semantically meaningless — which peer happens to have a higher random number dictates the outcome.

## 2. Observation

ClientId comparison is the *last* tiebreaker in CRDT conflict resolution. It fires when all structural information (causal order, origin pointers, logical timestamps) is equal. The choice of tiebreaker value is unconstrained — any total order works.

If we assign clientIds from priority-ordered ranges instead of random values, the tiebreaker becomes a category selector. Operations in higher ranges always win over operations in lower ranges when they conflict for the same position or key.

## 3. Technique

Partition the safe integer space into non-overlapping ranges, ordered by priority:

```
Range                          Priority   Purpose
[0, 2^32)                      lowest     Regular client operations
[2^32, 2^33)                   low        Ephemeral sessions (liminal)
[2^33, 31 × 2^40)              medium     Committed ephemeral (permanent facts)
[31 × 2^40, MAX_SAFE_INTEGER]  highest    Deterministic scaffold (genesis)
```

Each operation is assigned a clientId from the range matching its semantic role. Within a range, identifiers are monotonically increasing to preserve temporal ordering.

### Properties

**P1. Category dominance.** An operation in range R_i always wins over an operation in range R_j when i > j and they conflict on the same CRDT position. No coordination required — the outcome is determined by the range assignment.

**P2. Temporal ordering within range.** Monotonic identifiers within a range ensure that later operations in the same category win over earlier ones. Combined with P1, this gives a two-level priority: category first, then recency.

**P3. Structural invariance.** The highest-priority range (genesis/scaffold) is never overridden by any user operation. Infrastructure created in this range is permanent by construction, not by access control.

**P4. Namespace isolation.** Operations in different ranges can be identified, filtered, and routed by simple integer comparison. Origin-based forwarding, UndoManager scope, and sync filtering can use range checks as constant-time discriminators.

## 4. Applications

### 4.1 Ephemeral State (Liminality)

Continuous gestures (slider drags, color pickers) produce high-frequency writes that should be visible locally but not committed to peers until the gesture completes. Assign these writes to the ephemeral range. On commit, rewrite their clientIds to the committed-ephemeral range.

The committed operations automatically win over any pre-gesture values (regular range) without explicit delete operations — the CRDT's own tiebreaker handles it. Uncommitted ephemeral operations are structurally below committed ones, so reverting is safe: removing ephemeral items leaves committed items as the winner.

### 4.2 Deterministic Scaffold (Genesis)

Document structure (type maps, schema containers) must exist before user operations and must never be undone. Assign scaffold operations to the highest range using content-addressed hashing: `clientId = hash(type, path) + GENESIS_BASE`.

Two independent peers producing the same scaffold get identical CRDT items (same clientId, same clock). Sync is a structural no-op — the items already exist on both peers. UndoManager ignores them (filtered by range check). No user operation can override them (lower range).

### 4.3 Undo Scope Filtering

The UndoManager captures operations by transaction origin. But some captured operations should be stripped from the undo stack — scaffold creation, for instance. Range check on clientId provides a constant-time filter:

```
if (isGenesisClientId(clientId)) stackItem.clients.delete(clientId);
```

No origin tracking needed. The clientId itself carries the semantic.

## 5. Constraints

**C1. Range exhaustion.** The ephemeral range must be large enough for all concurrent sessions. With `[2^32, 2^33)` (4 billion values) and monotonic allocation, exhaustion requires 4 billion liminal sessions — impractical.

**C2. Cross-peer collision.** Two peers independently assigning clientIds in the same range could collide. For random allocation within a range, birthday-bound collision probability follows `p ≈ n²/2m` where n is the number of assignments and m is the range size. For 1000 sessions in a 2^32 range: `p ≈ 10^6 / 2^33 ≈ 1.2 × 10^{-4}`. For genesis (2^45 range, 10K scaffolds): `p ≈ 10^8 / 2^46 ≈ 1.4 × 10^{-6}`.

**C3. Wire format compatibility.** The technique requires clientIds larger than the standard uint32 range. Yjs uses variable-length integer encoding (lib0 varUint), which supports values up to 2^53. No protocol changes needed. Encoded size increases by 1-2 bytes for high-range clientIds.

## 6. Related Work

Shapiro et al. [2] formalize CRDTs using join-semilattices where replica identifiers participate in the merge function. Weidner et al. [3] compose CRDTs via semidirect products with an arbitration order. Both treat identifiers as opaque. Sanjuán et al. [4] use content-addressed hashing for Merkle-CRDTs but for operation identity (deduplication), not conflict resolution priority.

To our knowledge, no prior work uses the replica identifier space as a semantic priority channel for conflict resolution.

## 7. Conclusion

Partitioning the clientId space into priority-ordered ranges is a zero-cost technique (no protocol changes, no additional messages, no coordination) that transforms CRDT conflict resolution from arbitrary tiebreaking into categorical guarantees. The technique is general — any CRDT using replica identifiers for conflict resolution can benefit. We demonstrate it in a production system with four ranges covering regular operations, ephemeral state, committed state, and deterministic infrastructure.

## References

[1] Nicolaescu, Jahns, Derntl, Klamma. "Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types." ACM GROUP, 2016.

[2] Shapiro, Preguiça, Baquero, Zawirski. "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA RR-7506, 2011.

[3] Weidner, Miller, Meiklejohn. "Composing and Decomposing Op-Based CRDTs with Semidirect Products." ICFP/PACMPL, 2020.

[4] Sanjuán, Pöyhtäri, Teixeira. "Merkle-CRDTs: Merkle-DAGs meet CRDTs." Protocol Labs, 2020.
