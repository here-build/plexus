import type * as Y from "yjs";

import { xmlElByUuid } from "./internal.js";
import type { CutLog, CutRef } from "./cut-log.js";
import type { Cut, DeleteRanges } from "./types.js";

function decodeValue(item: Y.Item): unknown {
  const content = item.content as unknown as { getContent?: () => unknown[] };
  return content.getContent?.()[item.length - 1];
}

/** Union the per-frame delete-deltas of every cut up to (and including) the target. */
function foldDeleted(cutsUpTo: Cut[]): DeleteRanges {
  const out: DeleteRanges = new Map();
  for (const cut of cutsUpTo) {
    cut.deletedRanges.forEach((ranges, client) => {
      const acc = out.get(client) ?? [];
      acc.push(...ranges);
      out.set(client, acc);
    });
  }
  return out;
}

function isDeletedAt(folded: DeleteRanges, client: number, clock: number): boolean {
  const ranges = folded.get(client);
  if (!ranges) return false;
  return ranges.some((r) => clock >= r.clock && clock < r.clock + r.len);
}

/**
 * The value of `entityUuid.field` as of `cut`. Walks the attribute's item chain and
 * returns the newest value visible at the cut (clock < cut.afterState[client] and not
 * deleted by any cut up to it).
 *
 * `cutsUpTo` = every cut with seq ≤ cut.seq (caller: `cutLog.range(0, cut.seq)`).
 */
export function valueAsOf(archive: Y.Doc, entityUuid: string, field: string, cut: Cut, cutsUpTo: Cut[]): unknown {
  const el = xmlElByUuid(archive, entityUuid);
  if (!el) return undefined;
  const sv = cut.afterState;
  const folded = foldDeleted(cutsUpTo);
  let item: Y.Item | null = ((el as unknown as { _map: Map<string, Y.Item> })._map.get(field) ?? null) as Y.Item | null;
  while (item) {
    const visibleByClock = item.id.clock < (sv.get(item.id.client) ?? 0);
    if (visibleByClock && !isDeletedAt(folded, item.id.client, item.id.clock)) return decodeValue(item);
    item = item.left as Y.Item | null;
  }
  return undefined;
}

/** Current value of `entityUuid.field` (live archive head). */
export function currentValue(archive: Y.Doc, entityUuid: string, field: string): unknown {
  return xmlElByUuid(archive, entityUuid)?.getAttribute(field);
}

/**
 * Convenience over {@link valueAsOf}: resolve `ref` against the cut-log and fetch
 * `range(0, seq)` internally, so callers pass a ref instead of assembling `cutsUpTo`.
 * Returns `undefined` if the ref doesn't resolve.
 */
export function valueAtRef(
  archive: Y.Doc,
  cutLog: CutLog,
  entityUuid: string,
  field: string,
  ref: CutRef,
): unknown {
  const cut = cutLog.resolveRef(ref);
  if (!cut) return undefined;
  return valueAsOf(archive, entityUuid, field, cut, cutLog.range(0, cut.seq));
}
