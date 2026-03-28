# Self-Resolving Entity Identifiers for Operation-Based CRDTs

> Draft — positioned for PaPoC (workshop paper, ~5 pages)

## Abstract

CRDT-backed applications universally maintain a mapping layer between application-level entity identifiers and CRDT-internal operation coordinates. We observe that this indirection is redundant: the CRDT already provides globally unique, causally ordered addresses for every operation. We present an encoding that collapses entity identity and physical CRDT address into a single fixed-length string, eliminating the mapping layer entirely. The encoding uses a 1-character lifecycle prefix and a 14-character base-63 body packing 51-bit replica identifier + 32-bit Lamport clock. Entity resolution becomes a decode followed by binary search on the operation log — O(log n) with no auxiliary data structures. Deployed in a production system (Plexus/Yjs) with 1061 tests.

## 1. The Reinvented Registry Problem

CRDT-backed collaborative applications maintain entities — objects with stable identity that outlive any editing session. Every team building on a CRDT framework independently discovers the same problem: how to give entities stable names.

The standard solution introduces two layers:

1. **External identity.** A random string (UUID v4, nanoid, or slug) that the application uses to refer to the entity. Generated independently of CRDT state. Stored as a value within the CRDT.
2. **Internal address.** The CRDT's native coordinate for the operation that created the entity — typically a {replicaId, sequence} pair in operation-based CRDTs.

These layers are connected by an application-managed registry: a Y.Map, an Automerge map, or a hand-rolled lookup table that maps external identifiers to CRDT state.

### 1.1 What Goes Wrong

The registry is reinvented by every team, and reinvented badly.

**Orphaned state.** The registry and the content are separate CRDT operations. Deleting an entity must delete both. In practice, one or the other is forgotten — producing orphaned mappings (identity without content) or orphaned content (content without identity). These ghosts accumulate silently, discoverable only through expensive consistency audits. Every team that has built entity management on Yjs has debugged this class of bug.

**Linear scans.** The hand-rolled registry is typically a Y.Map iterated with `for (const [k, v] of map) if (v.id === target)`. This is O(n) per lookup. The CRDT's own operation log, by contrast, is sorted and supports O(log n) binary search — but the registry layer cannot use it because the external identifier has no structural relationship to the internal address.

**Replicated overhead.** The registry is itself collaborative state. Every entity creation writes two CRDT operations: one for the content, one for the mapping. Every sync, snapshot, undo/redo, and merge processes both. For documents with thousands of entities, the registry approaches the content in operation count.

**Snapshot fragility.** When entity A references entity B by external identifier, the reference is opaque — it cannot be validated, inspected, or traversed without the registry. Serialized snapshots that include cross-references are not self-contained: they require the entire registry to remain interpretable. Export, import, and offline reconciliation all inherit this dependency.

**Dual collision domain.** External identifiers and CRDT addresses occupy separate namespaces with separate uniqueness guarantees. The system must reason about both failure modes independently.

### 1.2 Prior Art

**Automerge** [1] is the closest predecessor. Each Automerge object receives an `objectId` derived from its creating operation's {actorId, counter}, formatted as `"{counter}@{actorId}"`. This collapses identity and address at the CRDT level. However: (a) objectIds are variable-length (128-bit actorIds produce ~40-character strings); (b) all objects share a single namespace with no lifecycle discrimination; (c) application-level entity identity (e.g., a row UUID visible to users) typically remains a separate concern layered on top.

**Yjs** [2] provides no built-in entity identity. The {clientID, clock} pair uniquely addresses every operation but is internal to the library.

**Liveblocks**, **Collabs**, **Peritext**, and **Fugue** each address identity at different levels but none provide a self-resolving fixed-length encoding of CRDT coordinates.

Our contribution over Automerge objectIds is: fixed-length encoding (15 characters regardless of identifier width), lifecycle-discriminated prefixes (routing without decoding), URL/JS/CSS-safe alphabet, and visual dispersion via reversible permutation. The core observation — that CRDT coordinates can serve as entity identity — is shared.

## 2. Technique

### 2.1 Encoding

An entity identifier is a 15-character ASCII string:

```
┌─ prefix (1 char): lifecycle stage
│  ┌─ body (14 chars): base-63 encoded {clientId, clock}
│  │
p  RxK4mN7pQ2wJbL
```

**Prefix alphabet:**

| Prefix | Lifecycle | ClientId Range |
|--------|-----------|----------------|
| `p` | User-created (persistent) | Regular [0, 2^51) |
| `l` | Liminal (ephemeral preview) | Liminal [2^51, 2^52) |
| `b` | Bound (cloned reference) | Regular [0, 2^51) |
| `d` | Deterministic (scaffold) | Genesis [3×2^51, 2^53) |

The lifecycle prefix depends on a companion namespace partitioning scheme [3] that assigns priority-ordered ranges to the replica identifier space. The prefix encodes the range, enabling routing decisions without decoding the body.

**Body encoding.** The body packs 83 bits into 14 base-63 characters (capacity: floor(14 × log2(63)) = floor(83.68) = 83 bits):

- `a`: upper 19 bits of clientId payload (clientId minus range base)
- `b`: lower 32 bits of clientId payload
- `c`: 32-bit Lamport clock

Combined value: `a × 2^64 + b × 2^32 + c`. Total: 19 + 32 + 32 = 83 bits.

These three unsigned integers form a big number represented as three uint32 chunks. Encoding extracts base-63 digits via long division across chunks; decoding reconstructs via long multiplication:

```
encode: for i = 13 downto 0:
          carry = 0
          for j = 0 to 2:
            cur = carry × 2^32 + chunk[j]
            chunk[j] = floor(cur / 63)
            carry = cur mod 63
          digit[i] = carry

decode: for i = 0 to 13:
          carry = digit[i]
          for j = 2 downto 0:
            cur = chunk[j] × 63 + carry
            chunk[j] = cur mod 2^32
            carry = floor(cur / 2^32)
```

All intermediates stay within JavaScript's safe integer range: max intermediate is 62 × 2^32 + (2^32 - 1) ≈ 2.7 × 10^11, well below 2^53.

**Alphabet:** `a-zA-Z0-9_` — 63 characters. Valid in JavaScript identifiers (`obj.pRxK4mN7pQ2wJbL`), CSS class names, HTML attributes, URL components, and JSON keys — all without escaping. The `-` character was excluded specifically to preserve JavaScript identifier validity.

### 2.2 Visual Dispersion

Sequential entity creation produces sequential {clientId, clock} pairs. Without treatment, consecutive identifiers differ only in trailing characters — making visual identification difficult and git diffs noisy.

We apply a 4-round balanced Feistel network on the lower 64 bits (b, c) before encoding. The upper 19 bits pass through unscrambled (they derive from the random base and rarely change between entities).

```
Round function: f(half, key) = murmurhash2_finalizer(half XOR key)
  where murmurhash2_finalizer(h) = h *= 0x5bd1e995; h ^= h >>> 13;
                                    h *= 0x5bd1e995; h ^= h >>> 15

Round keys: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a]
            (fractional parts of sqrt(2,3,5,7) — nothing-up-my-sleeve constants)
```

Properties: bijective (standard Feistel result [4]), invertible in O(1), empirically dispersive for sequential inputs. Not cryptographic — the round keys are public constants. Any invertible permutation with adequate avalanche would serve the same purpose; the Feistel structure is an ergonomic choice, not a correctness requirement.

Deterministic-range identifiers (`d` prefix) skip the Feistel step: they are already content-addressed hashes with inherent dispersion.

### 2.3 Resolution

```
1. Read prefix → determine lifecycle stage and clientId range base
2. Decode body → {a, fL, fR}
3. Feistel decrypt → {b, c} = {payloadLo, clock}  (skip for 'd')
4. Reconstruct: clientId = a × 2^32 + b + base
5. Binary search StructStore for (clientId, clock)
```

Step 5 uses the CRDT runtime's native operation lookup — in Yjs, a binary search over the per-clientId sorted item array. No auxiliary index or mapping table.

**Complexity:** O(1) decode (14 multiply-accumulate steps + 4 Feistel rounds) + O(log m) binary search where m is the operation count for the relevant clientId.

### 2.4 Properties

**P1. Self-resolving.** The identifier contains the complete physical address. Any peer with the relevant operations can resolve it — no registry required. Snapshots with cross-references are self-contained.

**P2. Uniqueness.** The encoding is a bijection: distinct {clientId, clock} pairs produce distinct identifiers. For user-created entities, uniqueness inherits from the CRDT's own replica isolation guarantee. For deterministic entities (`d` prefix), identity is content-addressed — two peers computing the same scaffold produce identical identifiers (intentional convergence, not collision resistance). The genesis hash uses 51 bits; birthday collision probability for 10K scaffold paths is ~2.2 × 10^-8.

**P3. Prefix discrimination.** Lifecycle stage is visible from the first character. Filtering, routing, and access control operate on the prefix without decoding. Examples: excluding scaffold entities from the undo stack, filtering ephemeral previews from persistence, blocking reparenting of cloned references.

**P4. Stable across sync.** The identifier encodes the creating operation's coordinates — identical on every peer that has received that operation. No consensus or central authority.

**P5. Compact.** 15 ASCII characters encode 83 bits of structured information plus lifecycle metadata. UUID v4 is 36 characters encoding 122 random bits with no structural content. For wider identifier systems (e.g., Automerge's 128-bit actorIds + 64-bit counters = 192 bits), the encoding scales to ceil(192/5.98) + 1 = 33 characters — at which point the compactness advantage over UUID v4 diminishes.

## 3. Applications

### 3.1 Eliminating the Registry

Entity creation produces one CRDT operation instead of two. In a production document with 10,000 entities, this eliminates 10,000 registry entries — each a Y.Map set operation contributing to sync, snapshot, and undo/redo processing. More importantly, it eliminates the orphaned-state failure mode entirely: there is no separate mapping that can fall out of sync with the content.

### 3.2 Lifecycle-Aware Routing

The prefix character enables constant-time routing without decoding. From the production system:

- **Undo filtering:** `d`-prefixed operations (scaffold) are excluded from the undo stack via a single character comparison.
- **Liminal isolation:** `l`-prefixed entities are ephemeral previews. The sync layer filters them from persistence: `if (id[0] === 'l') skipPersistence()`.
- **Clone protection:** `b`-prefixed entities cannot be reparented. The binding layer enforces this by prefix.

This capability depends on the companion namespace partitioning scheme [3], which assigns priority-ordered clientId ranges to lifecycle stages.

### 3.3 Deterministic Scaffold Convergence

Scaffold entities (schema containers, type maps) use the `d` prefix with content-addressed clientIds derived from a pure function of (type, path). Each scaffold element is produced in a throwaway CRDT document — guaranteeing clock = 0. Two independent peers computing the same scaffold produce byte-identical operations and therefore identical identifiers.

This is a hybrid of coordinate-addressed identity (for user-created entities) and content-addressed identity (for structural entities), unified under a single encoding with prefix discrimination. The combination echoes content-addressed storage (IPFS CIDs use self-describing prefixes for a similar purpose) while preserving the mutability that CRDT entities require.

### 3.4 Portable Snapshots

Serialized snapshots contain entity identifiers as plain strings. Because identifiers are self-resolving, any peer can traverse cross-references by decoding and searching its own operation log. No companion registry artifact is needed for export, import, or offline reconciliation.

## 4. Constraints

**C1. Operation-based CRDTs only.** The technique requires a CRDT where each operation has a unique {replicaId, sequence} pair and the operation log supports efficient lookup by those coordinates. It does not apply to state-based CRDTs or position-based sequence CRDTs (Logoot/LSEQ).

**C2. Immutable identity.** The identifier is derived from the creating operation and cannot change. Lifecycle transitions (e.g., liminal → committed) produce a new operation with a new identifier; the relationship between identifiers is recoverable from the clientId namespace arithmetic.

**C3. Cooperative deployment.** The encoding is not authenticated. A malicious peer can craft identifiers that decode to arbitrary {clientId, clock} pairs. Prefix-based routing is cosmetic, not a security boundary — the prefix is not cryptographically bound to the payload. Enforcement requires a validation layer (server-side relay, authenticated sync) outside the encoding. This is comparable to how CRDTs generally assume authenticated peer identity.

**C4. Information exposure.** Given a set of identifiers from a single peer, an attacker recovers the complete Lamport clock sequence — revealing the total order of entity creation, including gaps that indicate non-entity operations. Acceptable for collaborative editing where operation metadata is visible to all peers; potentially unacceptable for privacy-sensitive deployments.

**C5. Garbage collection dependency.** If the CRDT runtime garbage-collects operations, identifiers pointing to collected operations become dangling. Our implementation requires Yjs's `gc: false` configuration to retain all operations. Systems with compaction must either prevent collection of referenced operations or treat unresolvable identifiers as dangling references.

**C6. Clock and identifier width.** The 32-bit clock supports ~4.3 billion operations per client — sufficient for collaborative editing but not unbounded. The 51-bit clientId + 32-bit clock = 83-bit payload is specific to JavaScript's safe integer constraint (2^53 - 1). Platforms with wider integers can use more bits. The encoding generalizes: base-63 at ~6 bits/character, parameterized by total payload width.

## 5. Related Work

**Automerge objectIds** [1] are the closest prior art, collapsing creating-operation coordinates into identity strings. Our work adds fixed-length encoding, lifecycle prefixes, and a URL-safe alphabet — practical refinements of the same core insight.

**Yjs** [2] provides the StructStore (sorted per-client operation log) that makes O(log n) resolution possible, but does not surface operation coordinates as entity identifiers.

**Semantic clientId partitioning** [3] — our companion technique — provides the namespace ranges that make lifecycle prefixes meaningful. The present work depends on [3] for its lifecycle features but the core encoding (collapsing {replicaId, clock} into a fixed-length string) is independent.

**Merkle-CRDTs** [5] use content-addressed hashing for operation identity (deduplication), not entity identity. The distinction: Merkle-CRDT hashes are content-derived (hash of operation payload), while our identifiers are coordinate-derived (position in the operation log). Content-derived identifiers enable deduplication; coordinate-derived identifiers enable O(log n) lookup in a sorted store. Our `d`-prefix genesis identifiers are content-addressed, making the system a hybrid of both approaches.

**Kleppmann** [6] frames the local-first software paradigm where CRDT-native applications operate. Our "reinvented registry" problem is a direct consequence of building entity-oriented applications on CRDTs without native entity identity.

**UUIDs** (RFC 9562) provide universal uniqueness through randomness (v4), timestamps (v7), or names (v5). None encode CRDT coordinates. A UUID v4 used as entity identity in a CRDT system requires the auxiliary mapping our technique eliminates.

## 6. Conclusion

CRDT operation coordinates are already globally unique, causally ordered, and available on every peer. Encoding them directly as entity identifiers eliminates a data structure (the registry), a class of bugs (orphaned mappings), and a layer of complexity (the O(n) lookup) that every CRDT-backed application independently reinvents.

The technique trades random UUID compatibility for self-resolution, uniqueness-by-construction, lifecycle discrimination, and portable snapshots. The costs — migration burden, privacy exposure of operation metadata, and coupling to the CRDT's garbage collection policy — are real but bounded.

The indirection layer was solving the identity problem again, unnecessarily.

## References

[1] Kleppmann, Beresford. "A Conflict-Free Replicated JSON Datatype." IEEE TPDS, 2017.

[2] Nicolaescu, Jahns, Derntl, Klamma. "Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types." ACM GROUP, 2016.

[3] [companion paper]. "Semantic Partitioning of Replica Identifiers for Priority-Ordered CRDT Conflict Resolution." 2025.

[4] Luby, Rackoff. "How to Construct Pseudorandom Permutations from Pseudorandom Functions." SIAM J. Computing, 1988.

[5] Sanjuán, Pöyhtäri, Teixeira. "Merkle-CRDTs: Merkle-DAGs meet CRDTs." Protocol Labs, 2020.

[6] Kleppmann, Wiggins, van Hardenberg, McGranaghan. "Local-First Software: You Own Your Data, in spite of the Cloud." Onward!, 2019.
