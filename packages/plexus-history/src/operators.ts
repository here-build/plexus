import type * as Y from "yjs";

import { changesBetween } from "./lift.js";
import { isInSubtree } from "./tree.js";
import type { CutLog } from "./cut-log.js";
import type { EntityRef, PlexusChange } from "./types.js";

// ── filterBy ──────────────────────────────────────────────────────────────────

export interface ChangeFilter {
  author?: string; // userId
  kind?: "human" | "agent" | "cli" | "system";
  verb?: PlexusChange["verb"] | PlexusChange["verb"][];
  entity?: string; // uuid
}

export function filterBy(changes: PlexusChange[], f: ChangeFilter): PlexusChange[] {
  const verbs = f.verb === undefined ? undefined : new Set(Array.isArray(f.verb) ? f.verb : [f.verb]);
  return changes.filter(
    (c) =>
      (f.author === undefined || c.author?.userId === f.author) &&
      (f.kind === undefined || c.author?.kind === f.kind) &&
      (verbs === undefined || verbs.has(c.verb)) &&
      (f.entity === undefined || c.entity.uuid === f.entity),
  );
}

// ── groupBy ─────────────────────────────────────────────────────────────────

export interface ChangeGroup {
  author: PlexusChange["author"];
  start: number;
  end: number;
  changes: PlexusChange[];
}

/**
 * Group a (seq-ordered) change list. "author" = consecutive same author; "burst" = same
 * author within `windowMs` (default 5min); "window" = fixed time buckets of `windowMs`.
 */
export function groupBy(
  changes: PlexusChange[],
  mode: "author" | "burst" | "window",
  windowMs = 5 * 60 * 1000,
): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  for (const c of changes) {
    const g = groups[groups.length - 1];
    const sameAuthor = g && g.author?.userId === c.author?.userId;
    const fits =
      g &&
      (mode === "author"
        ? sameAuthor
        : mode === "burst"
          ? sameAuthor && c.timestamp - g.end <= windowMs
          : Math.floor(c.timestamp / windowMs) === Math.floor(g.start / windowMs));
    if (fits) {
      g.changes.push(c);
      g.end = c.timestamp;
    } else {
      groups.push({ author: c.author, start: c.timestamp, end: c.timestamp, changes: [c] });
    }
  }
  return groups;
}

// ── subtreeScope ──────────────────────────────────────────────────────────────

export interface SubtreeScopeOpts {
  /**
   * When given, membership is computed AS OF each change's own cut (reparent-aware) instead
   * of the archive's current tree — so "history of folder F" stays correct across moves.
   */
  cutLog?: CutLog;
}

/**
 * Scope changes to entities within `roots`' ownership subtree.
 *
 * Default (no `cutLog`): membership against the archive's CURRENT tree — fast, but it
 * mislabels entities reparented since (a file moved *out* of F drops its in-F history; one
 * moved *in* gains history it didn't have). Pass `{ cutLog }` for AS-OF-CUT membership: each
 * change is tested against the tree as it was at that change's own cut, and a move whose
 * *other* endpoint was in-scope (moved-in-from / moved-out-to) is kept as a boundary event.
 */
export function subtreeScope(
  changes: PlexusChange[],
  roots: string[],
  archive: Y.Doc,
  opts?: SubtreeScopeOpts,
): PlexusChange[] {
  const rootSet = new Set(roots);
  const log = opts?.cutLog;
  return changes.filter((c) => {
    const atCut = log?.get(c.seq);
    const cutsUpTo = atCut && log ? log.range(0, c.seq) : undefined;
    const inScope = (uuid: string): boolean => isInSubtree(archive, uuid, rootSet, atCut, cutsUpTo);
    return inScope(c.entity.uuid) || (c.from ? inScope(c.from.uuid) : false) || (c.to ? inScope(c.to.uuid) : false);
  });
}

// ── decorate (label hook) ─────────────────────────────────────────────────────

/**
 * Fill `entity.label` (+ `from`/`to` labels) on each change via a product-supplied resolver.
 * `atSeq`-aware so renames render correctly at historical positions. The package threads the
 * hook; resolving a name (a product-specific field) stays the product's job. Pair with
 * {@link ancestorChain} when the product wants a full path.
 */
export function decorate(
  changes: PlexusChange[],
  resolveLabel: (ref: EntityRef, atSeq: number) => string,
): PlexusChange[] {
  const lbl = (ref: EntityRef, seq: number): EntityRef => ({ ...ref, label: resolveLabel(ref, seq) });
  return changes.map((c) => ({
    ...c,
    entity: lbl(c.entity, c.seq),
    ...(c.from ? { from: lbl(c.from, c.seq) } : {}),
    ...(c.to ? { to: lbl(c.to, c.seq) } : {}),
  }));
}

// ── changesSince (the resumable feed cursor) ──────────────────────────────────

/**
 * Poll-feed for an agent: all changes after `cursorSeq`, plus the next cursor.
 * Push (in-page) is `onCut` from bindCapture / observing the cut-log.
 */
export function changesSince(
  cutLog: CutLog,
  archive: Y.Doc,
  cursorSeq: number,
): { changes: PlexusChange[]; nextCursor: number } {
  const head = cutLog.latest();
  if (!head || head.seq <= cursorSeq) return { changes: [], nextCursor: cursorSeq };
  const cuts = cutLog.range(cursorSeq + 1, head.seq);
  const from = cursorSeq >= 0 ? (cutLog.get(cursorSeq) ?? null) : null;
  return { changes: changesBetween(archive, from, head, cuts), nextCursor: head.seq };
}

// ── blame ─────────────────────────────────────────────────────────────────────

/**
 * Last writer per field for an entity, folded over the whole log (seq-ordered ⇒ last wins).
 * Fieldless verbs (reparent / detach / materialized) key on `\0<verb>`. O(history) — back it
 * with an index if it becomes a hot path.
 */
export function blame(archive: Y.Doc, cutLog: CutLog, uuid: string): Map<string, PlexusChange> {
  const last = new Map<string, PlexusChange>();
  const head = cutLog.latest();
  if (!head) return last;
  for (const c of changesBetween(archive, null, head, cutLog.range(0, head.seq))) {
    if (c.entity.uuid !== uuid) continue;
    last.set(c.field ?? `${String.fromCharCode(0)}${c.verb}`, c);
  }
  return last;
}
