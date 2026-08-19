import * as Y from "yjs";

import { MissingStructError, type Cut, type RawChange, type StateVector } from "./types.js";

/**
 * INTERNAL content-blind struct differ, emitting ONE RawChange per logical (client, clock)
 * — NOT per struct. Yjs merges adjacent same-client deleted items into one multi-length
 * struct (content = array of values); a per-struct walk would mis-decode the value
 * (`getContent()[length-1]` is always the last) and miss in-range clocks (a struct's base
 * clock can fall below the frame start). Per-clock + decode-at-clock handles the merge.
 *
 * Inserts = clocks in `[cutA.afterState, cutB.afterState)` per client (from the archive);
 * deletes = the union of `deletedRanges` over `cutsInRange`. `archive` MUST be gc:false.
 * Throws {@link MissingStructError} on an unresolvable delete.
 */
export function rawChangesBetween(archive: Y.Doc, cutA: Cut | null, cutB: Cut, cutsInRange: Cut[]): RawChange[] {
  const fromSV: StateVector = cutA ? cutA.afterState : new Map();
  const changes: RawChange[] = [];

  cutB.afterState.forEach((toClock, client) => {
    const start = fromSV.get(client) ?? 0;
    if (toClock <= start) return;
    const structs = archive.store.clients.get(client);
    if (structs === undefined) return;
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      const base = struct.id.clock;
      if (base >= toClock) break; // clock-sorted
      const lo = Math.max(base, start);
      const hi = Math.min(base + struct.length, toClock);
      for (let clock = lo; clock < hi; clock++) {
        changes.push({ kind: "insert", id: { client, clock }, item: struct });
      }
    }
  });

  for (const cut of cutsInRange) {
    cut.deletedRanges.forEach((ranges, client) => {
      for (const range of ranges) {
        const end = range.clock + range.len;
        for (let clock = range.clock; clock < end; clock++) {
          let struct: ReturnType<typeof Y.getItem> | undefined;
          try {
            struct = Y.getItem(archive.store, Y.createID(client, clock));
          } catch {
            throw new MissingStructError({ client, clock });
          }
          if (struct instanceof Y.Item) {
            changes.push({ kind: "delete", id: { client, clock }, item: struct });
          } else {
            throw new MissingStructError({ client, clock });
          }
        }
      }
    });
  }

  return changes;
}
