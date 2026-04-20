# Adapting Categorical CRDT Lifecycle to Op-Based CRDTs via Replica-Identifier Partitioning

> Draft — preprint

## Abstract

Yu et al. [5] introduced a lifecycle-counter technique for state-based CRDTs, encoding per-operation state (undone vs. active) in a second timestamp dimension alongside the primary clock. The broader insight in that work is that a CRDT's resolution algebra admits categorical load on a second dimension without breaking convergence. Op-based CRDTs (YATA [1], RGA [2]) lack an explicit second dimension in their standard formulation but expose a structurally similar feature — the replica-identifier tiebreaker — that established practice (notably Jahns' Yjs guidance [13]) treats as opaque. We show that partitioning the replica-identifier space into priority-ordered categorical ranges ports Yu's lifecycle-dimension semantics to op-based CRDTs without protocol changes. The construction also delivers a property Yu's per-operation carrier cannot: because the partition is a uniform order-preserving shift applied to each peer's identifier, the inter-peer tiebreaker is invariant across lifecycle stages — a peer that wins ties in one stage wins in every stage, which is what makes multi-peer collaboration under categorical priorities well-behaved. The whole construction lives inside Lamport's permissive "any total order" [6] formulation, so convergence follows from the base algorithm's correctness. Deployed in Plexus/Yjs, where it underpins deterministic genesis convergence, ephemeral-session isolation, and lifecycle-aware undo filtering (developed in companion work [9–11]).

## 1. Introduction

The core insight — that a CRDT's resolution algebra admits categorical load on a second dimension without breaking convergence — is Yu et al.'s [5], developed in the state-based setting. This paper adapts the insight to op-based CRDTs (YATA, RGA and their families) via a specific construction: partitioning the replica-identifier space into priority-ordered ranges. We describe the construction, the conditions under which it is safe, and how the companion papers in this stack use it.

The partitioning scheme described here was built first: it is the identifier-allocation policy of `@here.build/plexus`, a publicly available op-based CRDT runtime on top of Yjs, and has been running in production use in applications built on here.build. Yu et al.'s categorical-second-dimension insight [5] informed the implementation from the start. What follows is the retrospective generalization — the invariants (§2.1) and host-CRDT assumptions (§2.3) that were implicit in the running code are made explicit here, along with the collision analysis (§3) that bounds its safety. The code is available at [https://github.com/here-build/foundations](https://github.com/here-build/foundations) (see `plexus/`).

### 1.1 Yu et al.'s second dimension (state-based)

State-based CRDTs have a well-defined algebra for concurrent operations: join-semilattice merge. They do not, in standard formulations, support undo — Dolan [12] proves algebraic undo of general CRDTs is impossible beyond counters. Yu, Elvinger, and Ignat (OPODIS 2019) attach a per-operation **undo-length counter** alongside the primary clock: even values mark an operation as active, odd values as undone. The counter is a second ordering dimension, carrying *categorical lifecycle state* that the primary clock cannot. Primary-clock convergence is untouched; the counter only affects application-level interpretation.

The broader move — a second timestamp dimension carrying application-semantic load — is the abstraction that matters. Yu's specific payload (undo state) is one instance; any categorical property orthogonal to causal ordering could sit on the same axis.

### 1.2 The op-based translation problem

Op-based CRDTs have a different shape. They don't have a single "state" object — they have a stream of operations. Their resolution algorithm uses a lexicographic comparison over (Lamport clock, replica-identifier) where the replica-identifier is conventionally a *uniqueness-only* tiebreaker. Established Yjs guidance is explicit: *"clientIDs are session identifiers, not designed to be used for anything else"* [13]. The formal CRDT literature is silent on identifier assignment policy; the opaqueness norm is an implementation default, not a theorem.

Direct application of Yu's technique — attaching a new per-operation counter — would require extending the op-based protocol with a new field on every operation, paying wire-format and compatibility costs on every existing deployment. The question is whether op-based CRDTs have a second dimension *already available* that could carry the same semantic load without a protocol extension.

### 1.3 The construction

We observe that the replica-identifier tiebreaker is exactly that second dimension. The resolution algorithm already reads it, it is already stable across peers, and it is already causally independent of the clock. Lamport's 1978 formulation [6] specified only "an arbitrary total ordering of the processes" — a permissive formulation the field narrowed over subsequent decades into a convention of randomness.

When the replica-identifier space is partitioned into priority-ordered categorical ranges, this existing axis carries Yu-style lifecycle semantics without a protocol change, a new field, or coordination. The construction is inside Lamport's permission (any total order includes priority-ordered ones); convergence follows from the base algorithm's convergence, because only the identifier each operation receives has changed, not the comparison function that consumes it.

Yu's categorical-second-dimension insight and Lamport's permissiveness pre-date the work; we are not claiming those. The contribution has two parts: an *adaptation* and an *extension*.

The present construction is general. Its invariants (P1–P3, §2.1) and convergence preservation (§2.2) depend only on assumptions stated abstractly (operation-based CRDT with numeric replica-identifier tiebreaker; §2.3 Applicability table) and hold across any runtime meeting them. The companion applications that build on this construction — genesis [9], liminality [10], entity-oriented architecture [11], composite keys [16] — are concretely *deployed* in Plexus/Yjs, and each addresses its portability commitments in its own constraints section and, where appropriate, in a dedicated appendix (notably [11] Appendix A and [10] Appendices A–C). The primitive of this paper is general; the applications it anchors are Yjs deployments with explicit portability analyses rather than demonstrated ports to Loro or Automerge.

The adaptation is bringing Yu's lifecycle-dimension semantics to op-based CRDTs where folk guidance had foreclosed the technique. The extension is a consequence of the specific carrier we use. Yu attaches his second dimension as a per-operation counter; we attach ours to the per-peer replica identifier. Because the carrier is per-peer and the partition is a uniform order-preserving shift, our construction enjoys a property Yu's doesn't: the inter-peer tiebreaker is invariant across lifecycle stages (§2.1, P3). Who wins ties in one stage wins ties in every stage. This is what makes multi-peer collaboration under categorical priorities well-behaved — users never get inconsistent winner-relationships depending on which lifecycle range their operations occupy.

The paper describes the construction, its invariants (including P3), collision analysis, and the companion applications that motivated it: deterministic genesis convergence [9], liminal state commit-rewrite [10], entity-oriented document architecture with lifecycle-discriminated identity encoding [11].

## 2. The Construction

Partition the replica-identifier space into non-overlapping ranges, ordered by priority. Yjs's identifier space is bounded by `2^53 − 1` (JavaScript safe integer); we use two leading bits as prefix, giving four equal ranges of `2^51` each:

```
Prefix  Range                     Size   Priority   Allocation       Purpose (Plexus)
0b00    [0, 2^51)                 2^51   lowest     random           Regular client operations
0b01    [2^51, 2^52)              2^51   low        base + counter   Ephemeral sessions
0b10    [2^52, 3×2^51)            2^51   medium     base + counter   Committed ephemeral
0b11    [3×2^51, 2^53)            2^51   highest    content hash     Deterministic genesis
```

All clientIds derive from a **single 51-bit random value** `X` generated once per peer:

```
X              = random51()                          // generated once
regular:         doc.clientID  = X                   // overwrite Yjs default
ephemeral N:     shadow.clientID = X + 2^51 + N      // monotonic counter within prefix
committed N:     X + 2^52 + N                        // same payload + offset
genesis:         3×2^51 + hash(type, path) mod 2^51  // independent, deterministic
```

The payload (lower 51 bits) is shared across the regular and ephemeral ranges — only the prefix bits distinguish the namespace. Within a range, the counter `N` occupies the lowest bits and the random entropy `X` occupies the upper bits.

The same scheme generalizes to other integer widths and partition counts. For identifier width `W` and `k` equally sized partition categories (with `k` a power of 2), range `i` occupies `[i × 2^(W−log₂ k), (i+1) × 2^(W−log₂ k))`, and the formulas above scale by substitution. Non-power-of-2 `k` is admissible via `⌈log₂ k⌉` prefix bits with the remaining prefix slots reserved — the construction still works, though some identifier space is wasted. Wider integer platforms (native 64-bit, 128-bit) can spend additional bits on finer partitioning, lower collision probability, or both. The 2-prefix/51-payload split in particular reflects JavaScript's 53-bit safe integer constraint; the construction itself is agnostic to the width.

### 2.1 Invariants

**P1. Category precedence.** For operations `a ∈ R_i` and `b ∈ R_j` with `i < j`, `clientId(a) < clientId(b)` by partition construction. Under max-wins tiebreaker comparison, `b` wins when the resolution algorithm reaches the identifier comparison. (Min-wins inverts the range ordering.) The invariant's force depends on how often the tiebreaker is reached in the host algorithm — §2.3 discusses this per-algorithm.

**P2. Session ordering.** Monotonic allocation within a range ensures later sessions produce higher identifiers on the same peer. Combined with P1, this gives two-level priority: category first, then recency. Cross-peer ordering within a range is not guaranteed — each peer maintains its own counter.

**P3. Inter-peer order preservation.** The partition is a *uniform shift* applied to every peer's underlying identifier. A peer's clientId in range `R_i` is `X + base_i`, where `X` is the peer's 51-bit random base (the same `X` reused across every stage the peer enters). Because the shift is order-preserving, the inter-peer tiebreaker is invariant across lifecycle stages: for any two peers A and B,

    X_A > X_B   ⇒   X_A + base_i > X_B + base_i   for every range i.

The tie-break rank between two peers is therefore the same in every range; the winner and loser of contested writes stay fixed across the regular, ephemeral, committed, and genesis stages.

Yu's carrier is a per-operation counter and has no notion of "peer A's tie-break rank" to preserve across stages. Because our carrier is the per-peer replica identifier, and because the partition is an order-preserving shift, the inter-peer invariance comes out of the construction without further work. It matters in practice because multi-peer collaboration under categorical priorities would otherwise produce inconsistent winner-relationships depending on which lifecycle stage the conflict happened to sit in.

### 2.2 Convergence preservation

The construction leaves the CRDT's comparison function unchanged and modifies only the identifier-assignment policy; global identifier uniqueness is preserved, since the partitioned random range (`2^51` per namespace) is larger than the default Yjs range (`2^32`) and strictly reduces collision probability (§3). Convergence is therefore inherited from the base algorithm.

Companion papers develop applications that manipulate identifiers beyond assignment — commit-time rewriting of item coordinates [10] and deterministic content-addressed IDs for genesis entities [9] — and each establishes its own convergence claim over the primitive defined here.

### 2.3 Applicability

The construction applies to operation-based CRDTs where replica identifiers serve as a tiebreaker in concurrent conflict resolution:

| Algorithm | Identifier role | Applicable |
|---|---|---|
| YATA (Yjs) [1] | Final tiebreaker for same-origin inserts and map entries | **Yes** |
| RGA [2] | Secondary tiebreaker after Lamport timestamp | **Yes** (only when Lamport ties) |
| Fugue | Final tiebreaker after structural checks | **Plausible** (unverified; only when structural checks tie) |
| Automerge [15] | Secondary tiebreaker (string actorIds — requires prefix partitioning) | **With adaptation** (actorIds are hex strings; leading-byte prefix partitioning is direct) |
| Logoot / LSEQ | Embedded in position-path construction | **No** — changes spatial distribution |
| Woot / TreeDoc | Structural disambiguation, not identifier comparison | **No** |
| State-based CRDTs | Merge via lattice join, identifiers not compared | **No** |

For algorithms where the tiebreaker is secondary (RGA, Fugue), category precedence manifests only in the subset of concurrent operations where primary ordering does not already disambiguate. The technique is useful precisely in that residual: primary ordering already covers the common case, and categorical priority supplies the lifecycle-sensitive resolution when it does not.

## 3. Collision Analysis

Because committed identifiers are permanent and session IDs are clustered around a single peer's random base, the collision model is *birthday on X values with the effective range reduced by session-block size*. Each peer's single 51-bit random value `X` determines all its clientIds; sessions occupy `X+1..X+N` — consuming `⌈log₂(N)⌉` bits from the lower end.

Collision probability (10 users × 1K reconnects = 10K random bases, `p < 0.01` required). The `2^32` columns are the default Yjs baseline; `2^51` columns reflect the partitioned-range baseline used in the construction:

| Sessions/base | Bits consumed | Effective bits at 2^32 | p at 2^32 | **Effective bits at 2^51** | **p at 2^51** |
|---|---|---|---|---|---|
| 1 | 0 | 32 | 1.2 × 10⁻² | 51 | **2.2 × 10⁻⁸** |
| 10 | 4 | 28 | 1.2 × 10⁻¹ | 47 | **2.2 × 10⁻⁷** |
| 100 | 7 | 25 | ~1.0 | 44 | **2.2 × 10⁻⁶** |
| 1000 | 10 | 22 | ~1.0 | 41 | **2.2 × 10⁻⁵** |
| 10000 | 14 | 18 | ~1.0 | 38 | **2.2 × 10⁻⁴** |

**Safety threshold: ≥33 effective random bits** for 10K bases at `p < 1%`. At `2^51`, the system supports up to ~262,144 sessions per reconnection (51 − 18 = 33 bits) before crossing 1%. At `2^32`, even 10 sessions is marginal. The uniform `2^51` range eliminates the need for asymmetric range sizing.

Genesis range collision (content-addressed hash, `2^51` range):

| Types per document | **p at 2^51** |
|---|---|
| 100 | 2.2 × 10⁻¹² |
| 1K | 2.2 × 10⁻⁸ |
| 10K | 2.2 × 10⁻⁸ |
| 100K (1M projects) | 2.2 × 10⁻⁶ |

**Failure mode.** A genesis collision means two distinct genesis paths hash to the same clientId. Yjs's StructStore identifies structs by `(clientID, clock)`; a second item with the same `(clientID, clock=0)` is treated as a duplicate of the first. The exact behavior (silent drop vs. integration error) depends on the integration path — remote integration may differ from local creation. The observable outcome in either case: the application sees at most one genesis entity at the colliding identifier, and the probability is bounded but the failure is silent from the application's perspective. Applications relying on genesis must tolerate this bound or validate genesis-path uniqueness out-of-band.

The collision analysis uses a non-cryptographic hash (Murmur3). Birthday bounds apply to random inputs. For adversarial inputs, targeted collisions are feasible in seconds of CPU — mitigation requires either cryptographic hashing or a validation layer outside the CRDT (§4, C2).

## 4. Constraints

**C1. Cooperative deployment.** The construction assumes participants assign identifiers honestly. A malicious peer can self-assign any clientId — including a genesis-range identifier producing conflict-winning items — and the CRDT will integrate it without objection. Enforcement requires a validation layer (server-side relay, authenticated sync) outside the primitive; this is comparable to how CRDTs generally assume authenticated peer identity.

**C2. Adversarial determinism.** Partitioning introduces an attack surface random-ID CRDTs do not have: an adversary with random IDs can only hope to win tiebreakers by chance, while an adversary under this scheme can guarantee wins on any contested write by selecting the highest available prefix. The opaqueness convention Jahns recommends [13] incidentally limits this attack (a random ID's expected priority outcome is, well, random); the construction trades that incidental limit for explicit priority semantics. Genesis integrity under adversarial inputs additionally requires either cryptographic hashing or out-of-band validation, since genesis-range assignment uses a non-cryptographic hash (Murmur3) vulnerable to targeted collisions (§3).

**C3. Single partition scheme per document.** All participants must agree on the range boundaries. Heterogeneous schemes produce divergent priority outcomes — convergence breaks. Agreement is a deployment-time invariant; the primitive does not check it.

**C4. Wire format.** Identifiers above `uint32` require variable-length encoding. Yjs uses lib0 varUint (supports up to `2^53`). High-range identifiers (prefixes `0b01`–`0b11`) add 3 bytes to the wire encoding vs regular `uint32`. JavaScript bitwise operators truncate to int32 — all high-range arithmetic must use float64 operations (`Math.floor`, `%`), not `|`, `&`, `<<`, `>>>` on the full value.

**C5. Information leakage.** Monotonic allocation reveals session count and relative ordering to peers who receive operations from that range. Acceptable for collaborative editing; potentially unacceptable for privacy-sensitive deployments.

## 5. Applications

The primitive is used in Plexus for techniques developed in companion work:

- **Deterministic genesis** [9] — highest-priority range with content-addressed identifiers for structural entities.
- **Liminal state** [10] — ephemeral and committed ranges for deferred-persistence operation lifecycles.
- **Entity-oriented CRDT documents** [11] — flat-shell document model using the prefix bits for lifecycle discrimination, with the concrete self-resolving UUID encoding defined in §5 of [11] and priority-ordered resolution routing operations through structural liveness tiers.
- **Composite entity-addressed keys** [16] — extends decodable entity references (§5 of [11]) into map-key positions with a structured serialization algebra.

Each companion paper establishes its own invariants and convergence claims over the primitive defined here. The primitive itself is intentionally small — a construction plus its invariants — so that downstream papers cite it uniformly without re-establishing its properties.

## 6. Related Work

**Yu et al.** [5] is the direct intellectual source. Their per-operation undo-length counter adds a categorical second dimension to state-based CRDT operations — active vs. undone — without breaking convergence. We port that second-dimension pattern to op-based CRDTs using the replica-identifier tiebreaker as the carrier rather than a new counter field. The payload is different (general lifecycle priority rather than undo state specifically), but the structural move — *categorical semantics on a second axis, leaving the primary clock untouched* — is the same.

**Lamport** [6] specified the identifier-as-tiebreaker pattern as "any arbitrary total ordering of the processes." The construction here fits inside that specification; we are not extending Lamport's formulation but exercising its permissive clause, which the field had narrowed by convention.

**Burckhardt** [3] formalizes CRDT resolution as two axes — *visibility* (causal) and *arbitration* (total). Burckhardt names the arbitration axis but leaves it unstructured beyond total-order; our technique gives that axis categorical structure without extending the framework. **Kulkarni et al.** [4] (hybrid logical clocks) and **Preguiça et al.** [14] (dotted version vectors) are adjacent precedents for multi-dimensional timestamps — HLC attaches physical time; dot stores structure the identifier for causality tracking rather than arbitration priority. Different payloads; the pattern of "structure a second axis, leave the primary clock untouched" is shared across the lineage.

**Shapiro et al.** [7] formalize CRDTs using join-semilattices where replica identifiers participate in the merge function. **Weidner et al.** [8] compose CRDTs via semidirect products with an explicit arbitration order, demonstrating that the ordering used for conflict resolution can be semantically meaningful.

**Established framework guidance** treats replica identifiers as opaque. Jahns' Yjs community guidance [13] — *"clientIDs are session identifiers, not designed to be used for anything else"* — is the most explicit articulation. The guidance is a reasonable default when resolution semantics are unknown; Yu's work demonstrates that with known semantics, structured assignment is safe and useful. The construction here applies that lesson to op-based CRDTs in ecosystems where the opaqueness norm had been treated as prescriptive.

## 7. Conclusion

This paper shows how to realize Yu et al.'s categorical-second-dimension technique in op-based CRDTs by partitioning the replica-identifier space into priority-ordered ranges. Yu established the semantic move in state-based CRDTs and Lamport's 1978 formulation already permitted structured replica orderings; the contribution here is the construction that makes Yu's categorical second dimension accessible in op-based systems without a protocol extension.

The applications that motivated the adaptation — deterministic genesis convergence [9], liminal state transitions [10], lifecycle-aware identity encoding [11] — each exercise the second-axis semantics for a different purpose. Together they illustrate that the same pattern Yu used for undo-state carries well beyond undo: genesis priority, ephemeral-session isolation, persistence filtering, and UUID-prefix routing are all instances of "categorical load on a second axis" once the axis becomes available.

Other CRDT metadata conventionally treated as opaque — logical-clock bits, operation identifiers, causal dependencies — may admit similar refinement, though that is outside the scope of this paper.

Convergence preservation under the construction is argued at the invariant level (§2.2): unchanged comparison function, preserved identifier uniqueness. Formal verification — e.g. via model-checking a YATA-plus-partitioning specification under concurrent liminal commits, genesis materialization, and partition-delayed sync, or via property-based testing against the Yjs and Loro reference implementations — is future work. The invariants P1–P3 are stated in a form amenable to such mechanization.

## References

[1] Nicolaescu, Jahns, Derntl, Klamma. "Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types." ACM GROUP, 2016.

[2] Roh, Jeon, Kim, Lee. "Replicated Abstract Data Types: Building Blocks for Collaborative Applications." JPDC, 2011.

[3] Burckhardt. *Principles of Eventual Consistency.* Foundations and Trends in Programming Languages, 2014.

[4] Kulkarni, Demirbas, Madappa, Avva, Leone. "Logical Physical Clocks." OPODIS, 2014.

[5] Yu, Elvinger, Ignat. "A Generic Undo Support for State-Based CRDTs." OPODIS, 2019.

[6] Lamport. "Time, Clocks, and the Ordering of Events in a Distributed System." Communications of the ACM, 21(7), 1978.

[7] Shapiro, Preguiça, Baquero, Zawirski. "A Comprehensive Study of Convergent and Commutative Replicated Data Types." INRIA RR-7506, 2011.

[8] Weidner, Miller, Meiklejohn. "Composing and Decomposing Op-Based CRDTs with Semidirect Products." ICFP / PACMPL, 2020.

[9] [companion paper]. "Deterministic Genesis: Coordination-Free Structural Initialization for Operation-Based CRDTs." Preprint, 2026.

[10] [companion paper]. "Liminal State: Deferred-Persistence Lifecycles for Operation-Based CRDTs." Preprint, 2026.

[11] [companion paper]. "Entity-Oriented CRDT Documents: Architecture, Identity, and Structural Liveness." Preprint, 2026.

[12] Dolan. "The Only Undoable CRDTs are Counters." arXiv:2006.10494, 2020.

[13] Jahns. *Globally unique client id.* Yjs Community discussion, discuss.yjs.dev/t/312, 2020.

[14] Preguiça, Baquero, Almeida, Fonte, Gonçalves. "Dotted Version Vectors: Logical Clocks for Optimistic Replication." arXiv:1011.5808, 2010.

[15] Kleppmann, Beresford. "A Conflict-Free Replicated JSON Datatype." IEEE TPDS, 2017.

[16] [companion paper]. "Composite Entity-Addressed Keys for CRDT Maps." Preprint, 2026.
