# `@here.build/plexus-history`

**The change-history layer over a `gc:false` Yjs/Plexus archive.** The live, per-transaction
edit history the flight-recorder, canvas-diff, and version-traversal project over. Shared by
here.build and Inhuman. (Distinct from `@here.build/project-git`, the coarse commit/deploy
version store — these are peers: `project-git` = deploy snapshots; `plexus-history` = continuous
edit history.)

Two faces:

## `@here.build/plexus-history` — the public READ surface

```ts
import { changesBetween, valueAsOf, subtreeScope, filterBy, groupBy, changesSince, InMemoryCutLog } from "@here.build/plexus-history";

// Semantic, plain-JSON changes between two cuts (each stamped with its provenance):
const changes = changesBetween(archive, cutA, cutB, cutsInRange); // PlexusChange[]
```

```ts
interface PlexusChange {           // plain JSON — crosses an MCP/process boundary
  seq; timestamp; author: UserSession | null;   // provenance ON the change
  verb: "materialized" | "set" | "clear" | "reparent" | "detach" | "insert" | "remove" | "reorder";
  entity: { uuid; type };           // resolved from the struct's parent (total — entities-forever)
  field?; before?; after?;          // before/after free (the insert+delete frame pairing)
  from?: { uuid; type }; to?: { uuid; type };   // reparent / detach
}
```

- **`changesBetween`** — the lift: raw structs → semantic, entity-level, JSON changes.
  **`changesByRef(archive, cutLog, fromRef, toRef)`** — same, resolving refs + assembling the range for you.
- **`ancestorChain(archive, uuid, asOfCut?, cutsUpTo?)`** — the `\0` ownership chain `[entity…root]`
  as `EntityRef[]`; `asOfCut` gives the tree *as it was then* (reparent-aware). The package gives the
  chain; the product turns it into a path string (it owns the name field).
- **`decorate(changes, resolveLabel)`** — fill `entity.label` (+ `from`/`to`) via a product hook,
  `atSeq`-aware (renames render right at historical positions).
- **`valueAsOf(archive, uuid, field, cut, cutsUpTo)`** / **`valueAtRef(archive, cutLog, uuid, field, ref)`** — point-in-time read.
- **`planRestore`** — forward changes to restore targets to a past cut (scalar set/clear + `\0`
  reparent/detach via `parent: true`); preview only, apply server-side.
- **`subtreeScope(changes, roots, archive, { cutLog })` / `filterBy` / `groupBy` / `blame` / `changesSince`** —
  operators over `PlexusChange[]`. `subtreeScope` is current-tree by default; pass `{ cutLog }` for
  as-of-cut (reparent-aware) membership.
- **`InMemoryCutLog`** (impl of `CutLog`) — `append` (strictly-increasing seq, gaps tolerated), `get`, `range`, `latest`,
  `resolveRef("HEAD" | "HEAD~n" | "@<ISO>" | seq)`. The address is the **seq** (single-writer ⇒
  monotonic ⇒ a complete address; no content hashes).

## `@here.build/plexus-history/capture` — the server CAPTURE surface (LogDO-wired)

```ts
import { bindCapture, captureCut, InMemoryCutLog } from "@here.build/plexus-history/capture";

const unbind = bindCapture(mainDoc, {
  clientIdToUserSession: (clientId) => resolveActor(clientId),   // host: PeerAttributionTracker
  originToUserSession: (origin) => resolveActorByOrigin(origin), // pure-delete fallback (no acting clientId)
  filter: (origin) => origin instanceof WebSocket,               // skip internal/shadow writes
  onCut: (cut) => void persist(cut),                             // async-aware, fire-and-forget
  startSeq: (cutLog.latest()?.seq ?? -1) + 1,                    // resume across restarts
});
```

Capture is **server plumbing, never a public capability**. It belongs on the synced/main doc,
server-side (NOT the shadow, NOT client-side). It owns the seq counter (resumable via `startSeq`)
and resolves the author at capture: acting clientId → `clientIdToUserSession`, falling back to
`originToUserSession` for a pure-delete txn (whose deleter isn't in `afterState`). `onCut` is
async-aware and fire-and-forget — a slow/failed persist drops a cut (a tolerated gap), never wedges
capture. `serializeCut`/`deserializeCut` make cuts persistable across the boundary.

## Why it works (the leverage)

- **entities-forever** ⇒ a struct's parent XmlElement is always in the archive ⇒
  `entity.uuid = encode(parent._item.id)` is O(1) and total. Restore = re-adopt, never resurrect.
- **single-writer leader** ⇒ seq is monotonic for free, and a complete address.
- **per-clock + decode-at-clock** ⇒ correct under Yjs's merge of adjacent deleted items.
- **set deletes the prior value in the same txn** (`Item.js:510`) ⇒ before/after pair within a frame.

`gc:false` on the addressed archive is a hard requirement.

## Resolved in v2.1 (the spatial-layer pass)

- **path↔entity bridge** — `ancestorChain` exposes the `\0`-walk every consumer was hand-rolling.
- **`subtreeScope` as-of-cut** — `{ cutLog }` gives reparent-aware membership (current-tree is the fast default).
- **`planRestore`** now covers `\0` reparent/detach (via `parent: true`) and scalar clear, not just set.
- **label decoration** — `decorate` + a product `resolveLabel` hook (`atSeq`-aware).
- **ergonomics** — `changesByRef` / `valueAtRef` (ref in, no manual `cutsInRange`/`cutsUpTo`); `blame`.
- **dedupe** — `xmlElByUuid` consolidated into `internal.ts`.

## Resolved in the hardening pass

- **delete-attribution** — `originToUserSession` fallback resolves the deleter of a pure-delete txn
  from the transaction `origin` (the acting clientId is absent from `afterState`).
- **de-wedged capture** — `onCut` is async-aware/fire-and-forget; `append` is gap-tolerant; the seq
  counter is resumable (`startSeq`). A dropped cut can no longer desync or crash capture.
- **`applyRestore(doc, plan)`** — applies a plan as forward Yjs mutations in one transaction
  (`set`/`clear`/`detach` full; `reparent` best-effort — preserves the `\0` field-key/meta from the
  current pointer). Server-gated.
- **`Cut` codec** — `serializeCut`/`deserializeCut` round-trip the `Map` fields.

## Known TODOs

- **Durable `CutLog`** (DO storage + R2) + the **LogDO co-flush** wiring — the `here.build/saas` server pass.
- **`planRestore`/`applyRestore`**: collection-element (Y.Array splice) restore, subtree auto-enumeration
  (caller-supplied), and a full `\0`-tuple in the plan for cross-field reparent restore.
- **delete-attribution precision**: the `origin` fallback covers the common case; a fully-precise
  deleter for non-WS origins needs wire-decoding the update.
- **`reorder`** verb not emitted (`materialized` is); **`valueAsOf`** imprecise across merged tombstones (edge).
