import type { PlexusChange } from "@here.build/plexus-history";
import type * as Y from "yjs";

import type { CutMeta, LensCtx } from "./area.js";
import { AREAS } from "./registry.js";
import { resolveChange } from "./resolve-change.js";
import type { IntentEvent } from "./types.js";

export type { LensCtx } from "./area.js";

/**
 * `PlexusChange[]` → `IntentEvent[]` — the describing layer's consolidation. The CENTRAL pipeline: it owns
 * the cut-level structure (clustering, FRESH, birth-root detection, absorption); the per-area RECOGNITION
 * lives in the {@link AREAS} registry (the clay tenet — each model area is its own moldable module).
 *
 * Per cut (`groupBy` seq): FRESH = entities materialized this cut. **FRESH-by-cut is the birth gate, NOT
 * before-presence** (hardening: some constructors — e.g. FrameConfig — write non-defaults at birth, so the
 * "after===default" test misfires). A fresh entity whose parent isn't fresh is a BIRTH ROOT → offered to the
 * areas' `recognizeBirth`; its fresh descendants, the ∅→default sets, the `Site.components` insert, and the
 * layout-shell RuleSet seeds MERGE into it (absorbed by the FRESH-membership rules below — this subsumes the
 * RuleSet-merge rule). Non-fresh changes are offered to `recognizeEdit`; anything unrecognized degrades to a
 * `RawEdit` (TOTAL coverage — never silently dropped).
 *
 * ★DECISION (V, via the real toy e2e): the FRESH-membership absorption is INTENTIONAL even for a LONE first
 * edit on an EXISTING node. A node's first style/handler/attr CREATES a fresh container (RuleSet /
 * EventHandlersSet / AttributesSet), and that establishing edit is absorbed as part of "the node now has this
 * shape"; only a SUBSEQUENT edit to the now-existing container emits (StylePropertyChanged etc.). This keeps
 * the elegant rule (no birth-cascade-vs-lone-container ancestry trace). It is NOT a bug — do not "fix" it.
 *
 * Per-cut only. Cross-cut net-collapse (rename A→B then B→C = one rename A→C) is a TODO.
 *
 * `archive` (optional) is the Y.Doc the changes came from. When given, every emitted event is STAMPED with
 * its object-centric resolution (`object` + typed `coordinate`) via {@link resolveChange} on its anchor
 * change — feeding Pass 2 ({@link import("./narrate.js").narrate}). Omit it for the humanize-only path
 * (events carry no object/coordinate; behavior is exactly as before — the existing callers are unchanged).
 */
export function consolidate(changes: PlexusChange[], ctx: LensCtx, archive?: Y.Doc): IntentEvent[] {
  const byCut = new Map<number, PlexusChange[]>();
  for (const c of changes) {
    const arr = byCut.get(c.seq);
    if (arr) arr.push(c);
    else byCut.set(c.seq, [c]);
  }
  const out: IntentEvent[] = [];
  for (const [seq, cut] of byCut) out.push(...consolidateCut(seq, cut, ctx, archive));
  return out;
}

/**
 * Stamp the object-centric resolution onto an emitted event (lens-architecture.md §1–4). The `anchor` is the
 * change the event was recognized FROM (the birth root, or the edit) — `resolveChange` walks its `parentChain`
 * to the named object + typed coordinate. No archive ⇒ pass through unstamped; an unresolved change (orphan /
 * unmodeled type) ⇒ unstamped (it falls to the subject/humanize path). Immutable — never mutates the area's event.
 */
function stamp(ev: IntentEvent, anchor: PlexusChange, ctx: LensCtx, archive: Y.Doc | undefined): IntentEvent {
  if (!archive) return ev;
  const r = resolveChange(anchor, archive, ctx);
  if (!r) return ev;
  return { ...ev, object: r.object, ...(r.coordinate ? { coordinate: r.coordinate } : {}) };
}

function consolidateCut(seq: number, cut: PlexusChange[], ctx: LensCtx, archive?: Y.Doc): IntentEvent[] {
  const sourceUuids = [...new Set(cut.map((c) => c.entity.uuid))];
  const meta: CutMeta = { seq, timestamp: cut[0]?.timestamp ?? 0, author: cut[0]?.author ?? null, sourceUuids };
  const fresh = new Set(cut.filter((c) => c.verb === "materialized").map((c) => c.entity.uuid));

  // parent (this cut) of each fresh entity, recovered from its reparent — to find birth ROOTS.
  const parentOfFresh = new Map<string, string>();
  for (const c of cut) {
    if (c.verb === "reparent" && c.to && fresh.has(c.entity.uuid)) parentOfFresh.set(c.entity.uuid, c.to.uuid);
  }

  const out: IntentEvent[] = [];

  // 1) Birth roots → offered to the areas. Fresh descendants (root TplTag, sub-nodes) are absorbed.
  for (const c of cut) {
    if (c.verb !== "materialized") continue;
    const u = c.entity.uuid;
    const parent = parentOfFresh.get(u);
    if (parent && fresh.has(parent)) continue; // fresh descendant → MERGED into its root
    const ev = recognizeBirth(c, ctx, meta, fresh);
    if (ev) out.push(stamp(ev, c, ctx, archive)); // unclaimed births absorb (MVP: only owned births EMIT; TODO: NodeAdded)
  }

  // 2) Non-fresh changes: recognize as edits. Birth-cluster members (fresh entities, and the
  //    collection-insert of a fresh child) are skipped — they were absorbed into the "created" event.
  for (const c of cut) {
    if (fresh.has(c.entity.uuid)) continue;
    if (insertsFreshChild(c, fresh)) continue;
    const ev = recognizeEdit(c, ctx, meta);
    if (ev) out.push(stamp(ev, c, ctx, archive));
  }

  return out;
}

/**
 * A collection insert/reorder whose value references a fresh entity = part of that entity's birth (e.g.
 * `Site.components` insert of a just-materialized component). The child ref reaches the lens either as a
 * bare uuid string or as a single-element `[uuid]` tuple (the Plexus child-list element shape).
 */
function insertsFreshChild(c: PlexusChange, fresh: Set<string>): boolean {
  if (c.verb !== "insert" && c.verb !== "reorder") return false;
  const v = c.after;
  const uuids = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return uuids.some((u) => fresh.has(u));
}

/** Offer a birth ROOT to each area; first non-null wins. Unclaimed → null (absorbed by the pipeline). */
function recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta, fresh: Set<string>): IntentEvent | null {
  for (const area of AREAS) {
    const ev = area.recognizeBirth?.(root, ctx, meta, fresh);
    if (ev) return ev;
  }
  return null;
}

/**
 * Offer a non-fresh change to each area; first non-null wins. Unclaimed → TOTAL-coverage RawEdit degrade,
 * EXCEPT the one central salience heuristic (a non-fresh ∅→X set is a deferred-default write, not a user
 * gesture → drop). The drop is NOT area-specific so it stays in the pipeline. DECISION 3 (V): a real
 * salience DROP-allowlist replaces it. For the toy scenario neither the drop nor the degrade fires.
 */
function recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): IntentEvent | null {
  for (const area of AREAS) {
    const ev = area.recognizeEdit?.(c, ctx, meta);
    if (ev) return ev;
  }
  if (c.verb === "set" && c.before === undefined) return null;
  // TOTAL-coverage degrade: recognized structurally, no dedicated intent yet. Never silently dropped.
  return {
    kind: "RawEdit",
    entityType: c.entity.type,
    entityLabel: ctx.nameOf(c.entity.uuid, meta.seq) ?? c.entity.type,
    field: c.field,
    verb: c.verb,
    before: c.before,
    after: c.after,
    sourceUuids: meta.sourceUuids,
    seq: meta.seq,
    timestamp: meta.timestamp,
    author: meta.author,
  };
}
