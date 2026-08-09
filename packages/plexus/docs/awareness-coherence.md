# Awareness Coherence — referential integrity across the serde membrane

**Status:** law — implemented in `src/awareness.ts` (gate) + `src/awareness-serde.ts`
(marker walk) + `src/deref.ts` (satisfiability probe).

## The law

**Anything that gets through the serialization membrane is expected to exist.** An entity
reference readable from awareness state resolves, unconditionally — the same class of
structural promise yjs makes about clientId sovereignty. `deref` is strict on every lane;
a failed deref anywhere is a bug, never a state a consumer handles.

The membrane holds both halves of the promise:

- **Write half** (already enforced): `serialize` refuses what it cannot vouch for —
  `referenceSymbol` throws on unmaterialized entities and cross-doc references. What a
  writer emits, the writer's doc contains.
- **Read half** (this document): an inbound awareness frame becomes **visible only when
  every entity reference in it is resolvable against the local doc**. Frames that arrive
  ahead of the doc are parked and released when the doc catches up.

Consumers on top (reactive lenses and UI paint) therefore never see a dangling
reference and never carry tolerance machinery. Hand-constructing `{"\0": [uuid]}` markers
to bypass the write half is forbidden for the same reason reading `tuple[0]` out of a raw
marker is: both forge or inspect a wire format whose guarantees live in this layer.

## Why gating, not tolerance

The doc lane and the awareness lane converge independently. Inside one doc, yjs buffers
pending updates until their dependencies arrive — an applied update can never reference a
struct the store lacks, which is exactly why strict `deref` is correct there. The awareness
protocol (y-protocols wire, LWW per client, no history) carries no causal metadata linking
a frame to a doc state, and cannot be retrofitted with any: on a fresh peer join the full
awareness dump and the doc sync stream race each other by design.

Teaching readers to tolerate the race (null-on-missing deref, try/catch in scans) accepts
the dangling state and spreads coping code through every consumer — and a MobX computed
that throws on the race caches the exception until an *awareness* atom changes, so a
transient few-hundred-ms window becomes a stuck scan. Gating makes the race unobservable
instead: the frame waits, the doc arrives, the frame applies through the normal change
path, every atom bumps. One mechanism, in the layer that owns the format.

## Mechanism

The gate lives in `applyAwarenessUpdate` — the single membrane crossing for inbound
frames. Local writes are never gated (the write half already vouches for them).

Per wire entry `(clientID, clock, state)`:

1. **Removals** (`state === null`) apply immediately and discard any parked entry for
   that clientID with an older-or-equal clock.
2. **States without ref markers** apply immediately. (Fast path: the raw JSON string is
   scanned for the `\\u0000` marker-key escape before any deep walk.)
3. **States with ref markers** are checked for satisfiability: every marker's uuid decodes
   to `(clientId, clock)` (CRDT-native Feistel), and the struct must be present in the
   local store *and* be live entity content. Present → apply. Absent → **park**.

Parking:

- At most one parked entry per clientID — the newest clock wins (awareness is LWW; older
  frames are superseded, not queued).
- A parked entry does **not** touch `states`/`meta` and emits nothing. Observers keep
  seeing the previous value: **last coherent frame wins**.
- On every doc update (listener attached lazily on first park), parked entries are
  re-checked; satisfiable ones apply through the normal path with their original origin,
  so change/update events, reactive atoms, and plane relays behave exactly as if the frame
  had just arrived.
- Parked entries for a peer are dropped when the peer's channel 0 is removed (timeout /
  explicit removal) and on awareness destroy.

Satisfiability, precisely (`isRefSatisfiable` in `deref.ts`) — behavior keys on the
**uuid kind**, which is decodable from the uuid itself:

- Entity-cache hit → satisfiable (already materialized).
- Dependency references (`[uuid, depId]`) → satisfiable; they resolve through the
  dependency-doc registry, which has its own lifecycle and failure semantics.
- **Regular uuids — the front-run case.** The uuid decodes to `(clientId, clock)`. If
  the local store's clock for that client has not reached the uuid's clock, the
  reference is *technically real but future*: the writer vouched for it, we simply have
  not synced yet. The frame parks — the field is not returned at all, the previous
  coherent state keeps painting ("this awareness record is not relevant yet"). Entity
  shells are append-only, so a covered clock implies a resolvable struct.
- **Liminal-kind uuids — the revert case.** A liminal-minted entity can legally die: the
  liminal layer gets reverted, and the reference is dead *forever* — parking would wait
  for a doc state that can never arrive. These refs pass the gate; the awareness read
  path resolves them or yields **null** for the field. `revertLiminality` emits an
  explicit console warning when awareness state still references entities of the
  reverted session — the author outlived their preview.

## Awareness binding law

Awareness is always bound to the **main (prime) doc**, never the liminal shadow —
liminal preview deltas themselves travel inside awareness, so binding awareness to the
shadow would be recursive. There is no sanctioned way to reference an entity that is not
in the main synced tree: adding the entity to something doc-synced is what makes it
awareness-representable. An unsynced/unhomed entity has no representation, and the write
half refuses it loudly.

## Boundaries and consequences

- **Channel 0 never parks** — schemas are string arrays, so membership, heartbeats, and
  peer GC are unaffected by gating.
- **A peer whose frame references entities the reader never receives** (partition,
  divergent doc) simply never becomes visible past its last coherent frame — which is the
  truthful rendering of "you cannot see what you cannot see." Peer timeout eventually
  clears it.
- **Ordering within one peer's channel is preserved**: clocks are compared exactly as
  before; a parked frame that is superseded before release never applies.
- **`getRawPeer` / `getRawLocalState` are unaffected** — raw reads see applied wire state;
  parked frames are not applied state.
- The gate walks only frames whose JSON contains the marker escape, and the doc-update
  re-check runs only while something is parked — steady-state cost is zero.

## Test anchors

`src/__tests__/9-awareness/awareness-coherence.test.ts`:

- ref-to-present entity applies immediately; plain frames unaffected
- ref-to-absent entity parks (no membership change, no events), releases on doc catch-up
  with ordinary change/update events
- newest-parked-wins: two incoherent frames, only the newer applies on release
- coherent frame supersedes an older parked one
- removal clears the parked entry
- deref after release returns the live model (strict deref, no throw)
