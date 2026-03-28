# Semantic Partitioning of Replica Identifiers for Priority-Ordered CRDT Conflict Resolution

> Draft — positioned for PaPoC (workshop paper, ~4 pages)

## Abstract

We show that partitioning CRDT replica identifiers into priority-ordered ranges transforms the conflict-resolution tiebreaker from an arbitrary per-replica decision into a deterministic per-category guarantee. Existing formalizations treat replica identifiers as opaque; we give them semantic load. We demonstrate the technique in a production system (Plexus/Yjs) with four ranges encoding lifecycle stage and structural role — regular operations, ephemeral sessions, committed ephemeral, and deterministic scaffold. The technique requires no protocol changes and no coordination, but assumes a cooperative deployment with a single agreed partition scheme per document.

## 1. Background

CRDT conflict resolution requires a total order over concurrent operations. In operation-based sequence CRDTs (YATA [1], RGA [2]), when two items share the same causal predecessor, the algorithm compares replica identifiers as a final tiebreaker: higher identifier wins rightward placement (YATA) or temporal precedence (RGA). The standard assumption: identifiers are random unique integers. The resolution is deterministic but semantically meaningless — which peer happens to have a higher random number dictates the outcome.

This assumption is a convention, not a protocol requirement. Relaxing it requires no changes to the CRDT specification, yet it converts a source of non-determinism (which replica wins) into a deterministic structural guarantee (which *category* wins). The asymmetry between the triviality of the mechanism and the strength of the guarantee is the core observation.

## 2. Technique

Partition the safe integer space into non-overlapping ranges, ordered by priority:

```
Prefix  Range                     Size   Priority   Allocation       Purpose
0b00    [0, 2^51)                 2^51   lowest     random (Yjs)     Regular client operations
0b01    [2^51, 2^52)              2^51   low        base + counter   Ephemeral sessions
0b10    [2^52, 3×2^51)            2^51   medium     base + counter   Committed ephemeral
0b11    [3×2^51, 2^53)            2^51   highest    content hash     Deterministic scaffold
```

Two leading bits encode the namespace; the remaining 51 bits are the payload. Each range has 2^51 values (2.25 × 10¹⁵) — uniform, no wasted space.

All clientIds derive from a **single 51-bit random value** X generated once per peer:

```
X            = random51()                          // generated once
regular:       doc.clientID = X                    // overwrite Yjs default
ephemeral:     shadow.clientID = X + 2^51          // prefix 0b01, same payload
session N:     shadow.clientID = X + 2^51 + N      // monotonic counter
committed N:   X + 2^52 + N                        // prefix 0b10, same payload + offset
genesis:       3×2^51 + hash(type, path) % 2^51    // independent, deterministic
```

One random value, four namespaces. The payload (lower 51 bits) is shared across regular and ephemeral — the prefix bits alone distinguish the namespace. Session counting consumes the lowest bits; the random entropy is in the upper bits.

### Three-Dimensional Operation Log

The monotonic counter within the ephemeral range creates a three-dimensional structure:

1. **Clock** — the standard Yjs Lamport clock (operation sequence within a session)
2. **Session** — the incremental counter (`base + 1, base + 2, ...`) identifying which ephemeral session produced the operation
3. **Namespace** — the range prefix (regular / ephemeral / committed / scaffold)

Namespace conversion is a single addition: `committedId = liminalId + 2^51` (flipping the prefix from 0b01 to 0b10). Given any committed identifier, the originating ephemeral session is recoverable: `liminalId = committedId - 2^51`. This enables targeted invalidation — when an ephemeral session commits, peers can identify and clean up exactly the preview items from that session by computing the source ephemeral identifier from the committed one.

### Properties

**P1. Category dominance.** An operation in range R_i always wins over an operation in range R_j (i > j) when they conflict on the same CRDT position and the algorithm reaches the identifier tiebreaker. This assumes the CRDT uses a maximum-wins comparison; minimum-wins inverts the range ordering.

**P2. Session ordering.** Monotonic allocation within a range ensures that later sessions produce higher identifiers. Combined with P1, this gives two-level priority: category first, then recency. This ordering is per-peer (each peer maintains its own counter), not global.

### Applicability

The technique applies to operation-based sequence CRDTs where replica identifiers serve as the final tiebreaker in positional conflict resolution:

| Algorithm | Identifier Role | Applicable |
|---|---|---|
| YATA (Yjs) | Final tiebreaker for same-origin inserts and map entries | **Yes** |
| RGA | Secondary tiebreaker after Lamport timestamp | **Yes** |
| Fugue | Final tiebreaker after structural checks | **Yes** |
| Automerge | Secondary tiebreaker (string actorIds — requires prefix partitioning) | **With adaptation** |
| Logoot/LSEQ | Embedded in position path construction | **No** — changes spatial distribution |
| Woot/TreeDoc | Structural disambiguation, not identifier comparison | **No** |
| State-based CRDTs | Merge via lattice join, identifiers not compared | **No** |

## 3. Applications

### 3.1 Ephemeral State (Liminality)

Continuous gestures (slider drags, color pickers) produce high-frequency writes that should be visible locally but not committed until the gesture completes. Assign these writes to the ephemeral range.

On commit, rewrite their identifiers to the committed range. In Yjs, this is a temporary in-memory mutation of the struct store: rewrite `item.id`, `item.origin`, and `item.rightOrigin` for all items under the ephemeral identifier, encode the delta, then restore. The encoded delta carries items under the committed identifier with origin pointers to pre-ephemeral items that all peers have.

The committed operations win over any pre-gesture values (regular range) via the CRDT's own tiebreaker — no explicit delete operations needed for scalar (Y.Map) attributes. For array operations, the committed delta carries the delete set.

### 3.2 Deterministic Scaffold (Genesis)

Document structure (type maps, schema containers) must exist before user operations and must never be undone. Assign scaffold operations to the highest range using content-addressed hashing.

Each scaffold element is produced in a throwaway Y.Doc with the deterministic identifier as its clientId. This guarantees clock = 0 for every scaffold item. Two independent peers computing the same scaffold produce identical items (same identifier, same clock, same content). Sync is a structural no-op — Yjs deduplicates identical items.

### 3.3 Undo Scope Filtering

Some captured operations should not appear on the undo stack — scaffold creation, for instance. The identifier range provides a constant-time filter:

```typescript
if (isGenesisClientId(clientId)) stackItem.clients.delete(clientId);
```

## 4. Constraints

**C1. Cooperative deployment.** The technique assumes all participants are honest. A malicious peer can self-assign a scaffold-range identifier and create permanent, conflict-winning items. Enforcement requires a validation layer (server-side relay, authenticated sync) outside the CRDT. This is comparable to how CRDTs generally assume authenticated peer identity.

**C2. Single partition scheme per document.** All participants must agree on the range boundaries. Heterogeneous schemes produce undefined conflict resolution behavior. Two independent systems sharing Yjs documents must coordinate their partition schemes or use non-overlapping ranges.

**C3. Collision probability.** Committed identifiers are permanent and clustered. Each peer's single 51-bit random value X determines all its clientIds; sessions occupy `X+1..X+N` — consuming `⌈log₂(N)⌉` bits from the lower end. The collision model is birthday on X values with the effective range reduced by the block size.

Collision probability (10 users × 1K reconnects = 10K random bases, p < 0.01 required):

| Sessions/base | Bits consumed | Effective bits at 2^32 | p at 2^32 | **Effective bits at 2^51** | **p at 2^51** |
|---|---|---|---|---|---|
| 1 | 0 | 32 | 1.2 × 10⁻² | 51 | **2.2 × 10⁻⁸** |
| 10 | 4 | 28 | 1.2 × 10⁻¹ | 47 | **2.2 × 10⁻⁷** |
| 100 | 7 | 25 | ~1.0 | 44 | **2.2 × 10⁻⁶** |
| 1000 | 10 | 22 | ~1.0 | 41 | **2.2 × 10⁻⁵** |
| 10000 | 14 | 18 | ~1.0 | 38 | **2.2 × 10⁻⁴** |

**Safety threshold: ≥33 effective random bits** for 10K bases at p < 1%. At 2^51, the system supports up to **262,144 sessions** per reconnection (51 - 18 = 33 bits) before crossing 1%. At 2^32, even 10 sessions is marginal. The uniform 2^51 range eliminates the need for asymmetric range sizing.

Genesis range collision (content-addressed hash, 2^51 range):

| Types per document | **p at 2^51** |
|---|---|
| 100 | 2.2 × 10⁻¹² |
| 1K | 2.2 × 10⁻⁸ |
| 10K | **2.2 × 10⁻⁸** |
| 100K (1M projects) | **2.2 × 10⁻⁶** |

At fleet scale (1M documents × 100K types): ~2 genesis collisions. For reference, at 2^32 with 10K types, collision is already 1.2% per document.

**C4. Wire format.** Identifiers above uint32 require variable-length encoding. Yjs uses lib0 varUint (supports up to 2^53). High-range identifiers (prefix 0b01–0b11) add 3 bytes to the wire encoding vs regular uint32. Entity UUIDs are 15 characters (1 prefix + 14 base63 body) encoding the full 51-bit payload + 32-bit clock = 83 bits without loss. JS bitwise operators truncate to int32 — all high-range arithmetic must use float64 operations (`Math.floor`, `%`), not `|`, `&`, `<<`, `>>>` on the full value.

**C5. Information leakage.** Monotonic allocation reveals session count and relative ordering to peers who receive operations from that range. Acceptable for collaborative editing; may be unacceptable for privacy-sensitive deployments.

**C6. Identifier width is implementation-dependent.** Our implementation uses 53-bit safe integers (the JavaScript/Yjs constraint — `Number.MAX_SAFE_INTEGER = 2^53 - 1`). This dictates 2 prefix bits + 51-bit payload. Implementations on platforms with wider integers (64-bit, 128-bit) can use more prefix bits for finer-grained namespaces or more payload bits for lower collision probability. The technique is parameterized by the available identifier width, not bound to 53 bits. The collision analysis generalizes: safety threshold is `≥33 effective random bits` regardless of total width.

## 5. Related Work

Shapiro et al. [3] formalize CRDTs using join-semilattices where replica identifiers participate in the merge function. Weidner et al. [4] compose CRDTs via semidirect products with an explicit arbitration order, demonstrating that the ordering used for conflict resolution can be semantically meaningful. Sanjuán et al. [5] use content-addressed hashing for Merkle-CRDTs, but for operation identity (deduplication), not conflict resolution priority. Attiya et al. [6] discuss tiebreaker semantics in their specification of collaborative text editing.

No prior work uses the replica identifier space as a priority channel encoding operation lifecycle stage.

## 6. Conclusion

Partitioning the replica identifier space into priority-ordered ranges transforms CRDT conflict resolution from arbitrary tiebreaking into categorical guarantees. The technique requires no protocol changes and no coordination. It applies to operation-based sequence CRDTs with identifier-based tiebreakers (YATA, RGA, Fugue) and has been validated in a production system with 1061 tests covering scalar and structural operations, multi-cycle commit/revert, peer sync, and undo/redo.

The technique raises a broader question: what other CRDT metadata can carry semantic load without violating convergence guarantees? Replica identifiers, logical timestamps, and operation identifiers all participate in resolution — and all are conventionally treated as opaque. Semantic partitioning may be one instance of a general principle: encoding application-level invariants into the resolution algebra itself.

## References

[1] Nicolaescu, Jahns, Derntl, Klamma. "Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types." ACM GROUP, 2016.

[2] Roh, Jeon, Kim, Lee. "Replicated Abstract Data Types: Building Blocks for Collaborative Applications." JPDC, 2011.

[3] Shapiro, Preguiça, Baquero, Zawirski. "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA RR-7506, 2011.

[4] Weidner, Miller, Meiklejohn. "Composing and Decomposing Op-Based CRDTs with Semidirect Products." ICFP/PACMPL, 2020.

[5] Sanjuán, Pöyhtäri, Teixeira. "Merkle-CRDTs: Merkle-DAGs meet CRDTs." Protocol Labs, 2020.

[6] Attiya, Burckhardt, Gotsman, Morrison, Yang, Zawirski. "Specification and Complexity of Collaborative Text Editing." ACM PODC, 2016.
