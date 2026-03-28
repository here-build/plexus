# Liminal State: Deferred Persistence for Operation-Based CRDTs via Shadow Document Isolation

> Draft — positioned for ECOOP or Onward! (full paper, ~12 pages)

## Abstract

CRDTs make every operation immediately permanent — eliminating coordination but creating a mismatch with interactive applications where most input is exploratory. We present *liminal state*, a shadow document architecture that defers persistence: operations within a session are held on a shadow CRDT document, invisible to peers and undo history, until explicitly committed as a single atomic delta. Commit uses encoding-level primitives — clientId rewriting and targeted delete set construction — that operate in O(session size). Peer preview of in-progress gestures is transported via the awareness protocol with adaptive broadcast. The technique handles both scalar and structural (array insert/delete/splice) operations. Deployed in a production CRDT framework (Plexus/Yjs).

## 1. The Permanence Problem

### 1.1 The Root Cause

CRDTs conflate exploratory input with committed intent. A slider drag, an IME composition, and a drag-reorder are all *explorations* — the user is discovering a value, not declaring one. The CRDT treats each intermediate state as a permanent decision.

Saito and Shapiro [1] define the standard lifecycle for optimistic replication: *"Operations issued in the optimistic mode accept or produce tentative states, while operations issued in the pessimistic mode appear as completed in a stable state, termed committed."* OT systems implement this directly — local operations are tentative until the server confirms ordering.

CRDTs deliberately eliminated this lifecycle. Every operation is immediately permanent: inserted into the operation log, replicated to all peers, persisted to storage. This eliminates the need for a central ordering authority — a fundamental improvement. But it means CRDTs have no native concept of "I'm still exploring."

Note: OT's tentative operations may be *reordered* by the server — the operation's final form is uncertain. Liminal state provides a different lifecycle: operations may be *discarded* entirely — the operation's existence is uncertain. The distinction matters: OT defers ordering; liminality defers existence. The mechanism is shadow document isolation rather than server coordination.

### 1.2 Five Consequences

**Gesture explosion.** A 10-second slider drag at 60fps produces 600 CRDT operations, each a permanent entry in the operation log. Undoing the drag requires 600 undo steps — or, with Yjs's default 500ms `captureTimeout`, an unpredictable number of grouped steps depending on drag speed and pauses. The tldraw team states: *"people would have to hit undo hundreds of times to get a shape to its previous location"* [2].

**Write amplification.** Those 600 operations are replicated to every peer and persisted to every storage backend. YKeyValue benchmarks show the cost: 100,000 Y.Map operations on 10 keys produce 525KB of CRDT metadata vs 271 bytes of actual content — a 2000:1 ratio [3]. For continuous gestures, the amplification is pure waste: only the final value matters.

**Undo granularity.** Every production CRDT application hacks undo grouping:

| System | Mechanism | Limitation |
|--------|-----------|------------|
| Yjs [4] | Timer debounce (500ms) | Arbitrary — splits mid-drag pauses |
| Liveblocks [5] | `pause()`/`resume()` | Imperative — missed resume breaks undo permanently |
| tldraw [2] | Mark/squash | Custom system, not CRDT-native |
| Figma [6] | Pause on mousedown | Server-authoritative, not decentralized |
| Xi-editor [7] | Semantic group IDs | Never productionized |

The academic assessment: *"There is currently no generally applicable undo support for CRDTs"* [8].

**IME composition.** During CJK input, intermediate keystrokes are tentative — the user is composing a character. In CRDTs, each keystroke becomes a permanent operation. This causes duplicate text (Tiptap #7271), raw pinyin leaking (Tiptap #7186), deleted text reappearing (Lexical #7779), and Slate being *"unusable at production level for most CJK languages"* [9]. The W3C created the EditContext API partly for this [10]. Liminal state provides a natural architecture for treating composition as tentative (enter liminality on `compositionstart`, commit on `compositionend`), though this requires binding-layer integration not yet implemented.

**Structural array operations.** Reordering a list during a drag requires array insert + delete. Unlike scalar Y.Map sets (which overwrite), array operations create permanent Items (Yjs's internal operation representation [11]) in the CRDT log. Undoing an array delete does not remove the tombstone — Yjs's UndoManager creates a NEW Item to "restore" the deleted element. This is a fundamental property of tombstone-based sequence CRDTs [8], not a Yjs implementation quirk: undoing a deletion requires inserting at a logical position that may have shifted, so a new operation is necessary.

## 2. Architecture

### 2.1 Shadow Document Isolation

Liminal state uses two CRDT documents per editing session:

- **Shadow document** — the working copy. Application reads and writes target shadow. Liminal operations are held here. Configured with `gc: false` to prevent garbage collection of Items referenced by committed deltas.
- **Main document** — the committed store. Syncs to peers via providers. Persisted to storage. Receives forwarded writes from shadow.

Normal (non-liminal) operations on shadow are forwarded to main via origin-based routing. During a liminal session, operations tagged with the liminal origin are held on shadow — not forwarded.

```
Normal write:   user → shadow (SHADOW_TO_MAIN) → forwarded to main → synced to peers
Liminal write:  user → shadow (LIMINAL) → held on shadow, not forwarded
Commit:         extractCommittedDelta(shadow, main) → apply to main → synced to peers
Revert:         UndoManager.undo() on shadow → liminal Items removed, main untouched
```

The shadow→main forwarding filter is a whitelist: only known-safe origins (`SHADOW_TO_MAIN`, `COMMIT_DELTA`, `FROM_SHADOW`, the main UndoManager instance) are forwarded. All other origins — including liminal writes, per-peer preview origins, and the liminal UndoManager — are blocked.

The shadow/main pattern is fully general — any CRDT runtime supporting multiple document instances and differential encoding can implement it. The delta algebra primitives (Section 3) are Yjs-specific. The namespace partitioning (Section 6, P7) is specific to CRDTs with numeric replica identifiers used as tiebreakers.

### 2.2 Namespace Scheme

Liminal state uses the semantic identifier partitioning scheme [12] to assign clientId ranges to lifecycle stages:

```
[0, 2^51)         Regular — normal user operations
[2^51, 2^52)      Liminal — ephemeral session operations
[2^52, 3×2^51)    Committed — committed liminal deltas
[3×2^51, 2^53)    Genesis — deterministic scaffold [21]
```

The namespace is encoded in the two leading bits of the 53-bit safe integer space. Namespace conversion is arithmetic: `committedId = liminalId + 2^51`. Given a committed clientId, the originating liminal session is recoverable: `liminalId = committedId - 2^51`.

### 2.3 Liminal Session Lifecycle

**Enter.** Increment the shadow document's clientId (strictly increasing, within the liminal range). Set the transaction origin to `LIMINAL`. All subsequent writes are held on shadow.

**Operate.** User interacts normally — slider drags, color picks, array reorders. Each operation is a CRDT write on shadow under the liminal clientId. A liminal UndoManager captures these.

**Commit.** The critical sequence, composed from encoding-level primitives (Section 3):

```
Algorithm: commitLiminality()
1.  limId ← shadow.clientID
2.  committedId ← limId + 2^51
3.  delta ← extractCommittedDelta(shadow, main.stateVector, limId, committedId)
4.  mainUndoManager.stopCapturing()
5.  applyUpdate(main, delta, COMMIT_DELTA)        // main mutated — syncs to peers
6.  mainUndoManager.stopCapturing()
7.  if delta contains liminal-range structs:
8.    preUndoClock ← getMaxClock(shadow, limId)
9.    liminalUndoManager.undoAll()                 // shadow cleanup
10.   postUndoClock ← getMaxClock(shadow, limId)
11.   if postUndoClock > preUndoClock:             // ghost detection
12.     applyUpdate(shadow, buildDeleteSet(limId, preUndoClock, postUndoClock))
13. shadow.clientID ← limId + 1                    // fresh clientId
14. clear liminal state flags
```

For pure-delete sessions (line 7: no liminal structs, only deletions), skip UndoManager undo entirely — the committed delta's delete set handles cleanup via main→shadow forwarding.

**Revert.** Undo the liminal session on shadow. Main is untouched. Fresh clientId.

**Crash recovery.** Crash at any point during commit either completes the commit (from main's perspective, if step 5 executed) or loses only the current liminal session (if step 5 did not execute). Main is the ground truth; shadow is ephemeral.

### 2.4 Commit Invariants

1. **Strictly increasing clientId.** Each session gets a fresh clientId via increment. Later sessions produce higher clientIds, ensuring deterministic conflict resolution ordering.
2. **Apply-before-undo.** Apply committed delta to main before undoing liminal Items on shadow. The delta's positional references (origin/rightOrigin) are valid only in the pre-undo state.
3. **Fresh clientId after commit/revert.** Prevents clock gaps — main never saw the liminal session's clocks, so subsequent writes under the same clientId would be silently dropped by Yjs.
4. **Liminal UndoManager forwarding block.** The liminal UndoManager's undo operations must not forward to main. The whitelist filter (Section 2.1) ensures this.
5. **Full delta encoding.** The committed delta is `mergeUpdates([rewrittenStructs, liminalDeleteSet])` — both new Items and liminal state cleanup in a single binary.
6. **ClientId isolation from setup writes.** The clientId is incremented on `enterLiminality`, not before — ensuring setup operations (genesis, lazy containers) use the regular clientId.
7. **Main UndoManager remote map changes.** The main UndoManager must be configured to ignore remote map changes (`ignoreRemoteMapChanges: true`). Without this, committed deltas (which use distinct clientIds per session) are classified as "remote" by the UndoManager's conflict detection, causing redo to silently fail after multiple commits.
8. **Undo boundary isolation.** `stopCapturing()` on the main UndoManager before AND after applying the committed delta (steps 4, 6). Without this, the committed delta may be merged with adjacent undo groups.

## 3. Encoding-Level Primitives

The commit operation uses three primitives that operate on the CRDT's binary encoding. These are not lattice-theoretic operations — they are protocol-level transformations on Yjs's specific binary format. They compose with the standard delta join (`Y.mergeUpdates`) but are outside the delta-state CRDT formalization [13].

All three operate in O(session size) — proportional to the number of Items created during the liminal session, not the total document size.

### 3.1 ClientId Rewriting

Given the shadow document's struct store containing Items under clientId L (liminal), produce an encoded update where those Items appear under clientId C (committed), with all structural references remapped.

```
extractCommittedDelta(shadow, mainStateVector, L, C):
  1. structs ← shadow.store.clients.get(L)
  2. shadow.store.clients.delete(L)
  3. shadow.store.clients.set(C, structs)
  4. For each Item in structs:
     - Rewrite item.id.client: L → C
     - Rewrite item.origin.client: L → C (if origin references L)
     - Rewrite item.rightOrigin.client: L → C (if rightOrigin references L)
     // Non-liminal references (other peers' Items) are left intact —
     // those Items already exist on main.
  5. encodedDelta ← Y.encodeStateAsUpdate(shadow, mainStateVector)
  6. Restore: reverse all rewrites (steps 2-4)
  7. deleteSet ← buildDeleteSetUpdate(L, 0, maxClock(L))
  8. Return Y.mergeUpdates([encodedDelta, deleteSet])
```

The rewrite is temporary in-place mutation — Items are rewritten, encoded, then restored. This is safe under JavaScript's single-threaded execution model and requires `Y.encodeStateAsUpdate` to be side-effect-free (no observers, no transactions).

### 3.2 Targeted Delete Set Construction

Given a clientId and a clock range, produce a CRDT update containing only a delete set — no struct blocks.

```
buildDeleteSetUpdate(clientId, clockStart, length):
  1. Encode 0 struct clients (empty struct block)
  2. Encode 1 delete set entry: {clientId, clock: clockStart, length}
  3. Return encoded update
```

Applied to a document, this marks exactly the specified Items as deleted without touching any other state.

### 3.3 Ghost Item Cleanup

When the UndoManager undoes array deletions, it creates NEW Items to "restore" deleted elements (Section 5.2). These ghosts have the liminal clientId but clock values beyond the session's original range.

Detection: compare `getMaxClock(shadow, liminalClientId)` before and after undo. If the clock advanced, the UndoManager created new Items. Build a targeted delete set for the ghost range and apply it.

The detection is conservative: it only fires when new Items appear under the liminal clientId during undo. This is correct because no other code creates Items under that clientId between the clock snapshot and the undo (the session is single-threaded and the clientId is isolated). If Yjs changes UndoManager behavior to flip delete flags instead of creating new Items, the detection becomes a no-op (safe degradation).

## 4. Peer Preview

### 4.1 Awareness Transport

Liminal previews are broadcast via the awareness protocol [14], not the CRDT sync layer:

```
awareness field "liminal": [height: number, startSec: number, base64delta: string]
```

- `height` — monotonic session counter (disambiguates successive sessions)
- `startSec` — wall-clock start time for collective TTL
- `base64delta` — current liminal state as an encoded Yjs update

The awareness channel is ephemeral: states auto-expire on disconnect (30s timeout), are not persisted, and generate zero entries in the permanent operation log.

**Trust boundary:** The preview delta is decoded and applied to the receiver's shadow document without content validation. A malicious peer could inject arbitrary state. The blast radius is limited to the shadow document — previews never reach main (blocked by the whitelist forwarding filter). Per-peer UndoManagers restore shadow state on preview cleanup. Production deployments should validate preview deltas at the server relay.

### 4.2 Adaptive Broadcast

Broadcast frequency adapts to CPU pressure via the PressureObserver API:

- **Nominal** → high-frequency updates (smooth preview)
- **Serious** → reduced frequency
- **Critical** → minimal updates (preserve responsiveness)

`visibilitychange` stops broadcast entirely when the tab is hidden. We are not aware of other collaborative systems that adapt preview frequency to device performance — Figma broadcasts at fixed 30fps [6], Liveblocks throttles presence at fixed 100ms [5].

### 4.3 Peer Preview Receiver

On receiving a preview: decode the base64 delta, apply to the local shadow document with a per-peer symbol origin, track for cleanup. On supersession or expiry: undo via per-peer UndoManager.

**Race condition:** The awareness clear (fast, awareness channel) may arrive before the committed delta (slower, CRDT sync). During the gap, the receiver sees the pre-gesture state. This is transient — the committed delta is idempotent and produces the correct final state when it arrives.

### 4.4 Collective TTL

All peers independently expire a liminal session after 5 minutes from `startSec`. This assumes approximately synchronized wall clocks — clock skew beyond TTL causes premature expiration (clock behind) or delayed cleanup (clock ahead). The awareness protocol's 30-second heartbeat timeout provides a secondary safety net regardless of clock agreement.

## 5. Structural Liminality

Scalar liminality (Y.Map operations) is clean: `map.set(key, value)` overwrites, undo restores, committed delta carries the final value.

Array liminality (Y.Array insert/delete/splice) is harder because array operations create permanent Items and tombstones in the CRDT log.

### 5.1 Three Cases

**Insert-only.** UndoManager undo marks liminal Items as deleted on shadow. Committed delta carries them under committed clientId. On main, they appear as new inserts.

**Delete-only.** No liminal-range structs — only delete set entries. Skip UndoManager undo (it would create ghost Items). Committed delta is a delete-set-only update.

**Mixed.** UndoManager undo + ghost detection + targeted delete set cleanup (Section 3.3).

### 5.2 The Ghost Problem

Undoing a deletion in a tombstone-based sequence CRDT requires inserting a new element at the logical position — which may have shifted due to concurrent operations [8, 11]. The UndoManager cannot flip the delete flag because the position is no longer guaranteed to be correct. It creates a new Item instead.

This is a fundamental property of sequence CRDTs with tombstones, not a Yjs implementation quirk. Any CRDT runtime implementing undo for sequence deletions faces the same problem. The ghost detection mechanism (Section 3.3) is Yjs-specific; the need for ghost cleanup is inherent.

## 6. Properties

**P1. Deferred persistence.** Operations are temporary by default (liminal), permanent on explicit commit. This matches interactive editing where most gestures are exploratory. The standard CRDT model makes every operation immediately permanent; liminality gates persistence on an explicit commit decision.

**P2. Low-cost exploration.** Liminal operations produce zero permanent entries in the main document's operation log. A reverted gesture leaves no trace on main. The shadow document's state vector and struct store do grow during liminal sessions (even reverted ones), and this accumulates over time with `gc: false`. Periodic shadow rebuild from main state mitigates this.

**P3. Atomic commit.** The committed delta is a single binary update encoding the net effect of the entire gesture. 600 intermediate slider values → 1 committed delta. The commit is one undo step regardless of gesture duration.

**P4. Structural soundness.** Array insert, delete, and splice during liminal sessions produce correct committed deltas via three-case dispatch (Section 5.1) and ghost cleanup (Section 3.3).

**P5. Peer preview without persistence.** In-progress gestures are visible to peers via the awareness channel. Zero permanent operations for previews. Auto-expires on disconnect or TTL.

**P6. Adaptive performance.** Broadcast frequency responds to CPU pressure. Tab-hidden suppression.

**P7. Namespace isolation.** Liminal, committed, regular, and genesis operations occupy non-overlapping clientId ranges [12]. Lifecycle stage is a single range check. Filtering, routing, and priority ordering derive from the namespace.

**P8. Concurrent cross-peer safety.** Two peers in simultaneous liminal sessions on the same entities operate independently on their shadow documents. Both commit. The committed deltas carry distinct clientIds and merge via normal CRDT conflict resolution. No special handling needed.

## 7. Constraints

**C1. Three-layer generalization.** The technique has three layers with different generality: (a) the shadow/main pattern — fully general, any CRDT runtime with multiple doc instances and differential encoding; (b) the namespace partitioning — generalizes to CRDTs with numeric replica IDs used as tiebreakers (Yjs, Loro); (c) the encoding-level primitives — Yjs-specific, requiring mutable Item IDs, `encodeStateAsUpdate` with state vector, and `mergeUpdates`. Loro's `export_from(VersionVector)` and numeric PeerID make it the most promising adoption target beyond Yjs.

**C2. Single active session.** One liminal session per Plexus instance. Multiple concurrent sessions would require sub-partitioning the liminal namespace.

**C3. Shadow document memory.** Raw CRDT state is approximately 2x. With `gc: false`, tombstones accumulate across sessions — after N sessions, shadow grows by O(N × session_size) in tombstones. The state vector grows by one entry per session (each committed clientId). Periodic shadow rebuild from main state (re-apply `Y.encodeStateAsUpdate(main)` to a fresh shadow) resets the accumulation. Startup cost: O(document size) for the initial shadow materialization.

**C4. Preview trust boundary.** Preview deltas are applied without content validation. Malicious previews are confined to shadow (never reach main) and cleaned up by per-peer UndoManagers. Hardening requires server-side delta validation at the awareness relay.

**C5. Clock skew in collective TTL.** The 5-minute TTL uses wall-clock comparison across peers. Clock skew beyond TTL causes premature expiration or delayed cleanup. The 30-second awareness heartbeat timeout provides a secondary safety net.

**C6. Ghost cleanup coupling.** Ghost Item detection assumes Yjs UndoManager creates new Items for array deletion undo. If this behavior changes, detection degrades to a no-op (safe but leaves ghosts on shadow). The fundamental need for ghost cleanup is inherent to tombstone-based sequence CRDTs; the detection mechanism is Yjs-specific.

**C7. IME integration requires binding layer.** Liminal state provides the architecture for treating IME composition as tentative (`enterLiminality` on `compositionstart`, `commitLiminality` on `compositionend`). The binding-layer integration (y-prosemirror, y-codemirror) is not yet implemented. Y.Text inherits from Y.Array in Yjs, so the structural liminality mechanisms (Section 5) apply to text operations.

## 8. Related Work

**Saito and Shapiro** [1] define the tentative/committed lifecycle for optimistic replication. OT's tentative operations may be reordered by a central authority — the operation's final form is uncertain. Liminality provides a structurally analogous but semantically distinct lifecycle: operations may be discarded — the operation's existence is uncertain. The mechanism is local isolation rather than server coordination.

**GGPO rollback netcode** [15] provides the most precise structural analogy. Confirmed state = main document. Predicted state = shadow document. Misprediction rollback = revert. Correction = commit. The difference: GGPO assumes deterministic simulation with a single authority; liminality operates in a decentralized CRDT. The analogy is structural, not exact — GGPO replays corrected inputs, liminality commits new operations.

**Automerge transactions** [18] provide commit/rollback within a single document. The critical difference: Automerge transactions are synchronous (closure-scoped), while liminal sessions span arbitrary wall-clock time (drag gestures, IME composition). Automerge has no shadow isolation, no peer preview, and no structural array ghost handling.

**Ink & Switch Upwelling** [16] introduces "drafts" as lightweight CRDT branches for creative privacy. The architecture is similar to shadow/main, but Upwelling uses full Automerge document clones and merge-based reconciliation. Liminality's shadow operates on the same Yjs document format with origin-based routing, using encoding-level primitives for surgical commit rather than full document merge.

**Ink & Switch Patchwork** [17] explores version control on Automerge documents with branches and merges. Like Upwelling, uses `clone()` + `merge()`.

**Liveblocks `pause()`/`resume()`** [5] provides explicit undo boundaries. This solves undo granularity but not write amplification (operations are still permanent), not peer preview, and not structural arrays.

**Delta-state CRDTs** [13] formalize delta composition via join-semilattice operations. Liminality's encoding-level primitives — clientId rewriting and targeted delete set construction — are outside this formalization. Neither appears in the standard delta algebra. They operate on the binary encoding layer, not on the lattice structure.

**Eg-walker** [19] (Gentle, Kleppmann) treats CRDT metadata as ephemeral computation, materialized only during merges and then discarded. Eg-walker makes the CRDT *metadata* ephemeral; liminality makes the *operations themselves* ephemeral until committed. These are orthogonal and could compose: a shadow document using eg-walker's approach would not maintain persistent CRDT metadata, addressing the memory concerns in C3.

**Yjs UndoManager** [4] groups operations by timer (`captureTimeout: 500ms`) with `stopCapturing()` for explicit boundaries. Yjs issue #290 (open since 2020) requests semantic grouping.

**Companion techniques.** Semantic identifier partitioning [12] provides the namespace ranges. Self-resolving entity identity [20] provides UUID encoding. Deterministic genesis [21] provides convergent initialization. Liminality composes with all three but the shadow/main pattern is architecturally independent.

## 9. Conclusion

CRDTs made every operation permanent to eliminate coordination. This was the right tradeoff for consistency, but it created a fundamental mismatch with interactive applications where most input is exploratory.

Liminal state provides a visibility lifecycle for CRDT operations — deferred persistence via shadow document isolation. The shadow holds exploratory state. Encoding-level primitives commit it atomically. The awareness protocol shares it with peers. The namespace partitioning makes lifecycle stages structurally distinguishable.

The costs are real: doubled memory for the shadow document (growing with `gc: false` over sessions), Yjs-specific encoding primitives, single active session, and ghost cleanup coupled to UndoManager behavior. The benefits are structural: 600 slider ticks become one committed delta, array reorders don't accumulate permanent ghosts, undo granularity is determined by the application rather than a timer, and peer preview generates zero permanent operations.

The CRDT provides convergent content. Genesis provides convergent structure. Liminality provides convergent *intent* — the distinction between "I'm exploring" and "I've decided."

## References

[1] Saito, Shapiro. "Optimistic Replication." ACM Computing Surveys, Vol. 37, No. 1, 2005.

[2] tldraw. "Multiplayer undo/redo." tldraw.dev, 2024.

[3] Yjs Utility (YKeyValue). github.com/yjs/y-utility, 2024.

[4] Yjs UndoManager. docs.yjs.dev/api/undo-manager, 2024.

[5] Liveblocks. "How to build undo/redo in a multiplayer environment." liveblocks.io/blog, 2024.

[6] Wallace. "How Figma's multiplayer technology works." figma.com/blog, 2019.

[7] Xi-editor. "CRDTs." xi-editor.io/docs/crdt.html, 2020.

[8] Yu, Elvinger, Ignat. "A Generic Undo Support for State-Based CRDTs." OPODIS, 2019.

[9] Slate. "Fix editing with IMEs." github.com/ianstormtaylor/slate/issues/4127.

[10] W3C. "EditContext API Explainer." w3c.github.io/editing/docs/EditContext/explainer.html, 2024.

[11] Yjs INTERNALS. github.com/yjs/yjs/blob/main/INTERNALS.md, 2024.

[12] [companion paper]. "Semantic Partitioning of Replica Identifiers for Priority-Ordered CRDT Conflict Resolution." 2025.

[13] Almeida, Shoker, Baquero. "Delta State Replicated Data Types." JPDC, 2018.

[14] [companion paper]. "Multi-Channel Awareness Protocol." (PlexusAwareness, Plexus/Yjs.)

[15] Cannon. "GGPO: Good Game Peace Out." ggpo.net, 2009.

[16] Ink & Switch. "Upwelling: Combining real-time collaboration with version control." inkandswitch.com, 2024.

[17] Ink & Switch. "Patchwork." inkandswitch.com/patchwork/, 2024.

[18] Automerge. "Transactions." automerge.org/automerge/api-docs/, 2024.

[19] Gentle, Kleppmann. "Collaborative Text Editing with Eg-walker." EuroSys / arXiv:2409.14252, 2025.

[20] [companion paper]. "Self-Resolving Entity Identifiers for Operation-Based CRDTs." 2025.

[21] [companion paper]. "Deterministic Genesis: Coordination-Free Structural Initialization for Operation-Based CRDTs." 2025.
