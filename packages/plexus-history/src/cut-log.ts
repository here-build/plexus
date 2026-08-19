import type { Cut, DeleteRanges, StateVector, UserSession } from "./types.js";

/** A reference into the log: a raw seq, `HEAD`, `HEAD~n`, or `@<ISO-timestamp>`. */
export type CutRef = number | "HEAD" | `HEAD~${number}` | `@${string}`;

export interface CutLog {
  /**
   * Append a cut. `seq` must be **strictly increasing** (single-writer leader ⇒ free), but
   * **gaps are tolerated** — a dropped / un-persisted cut leaves a missing frame, not a wedge.
   * Returns the stored cut.
   */
  append(cut: Cut): Cut;
  get(seq: number): Cut | undefined;
  /** Inclusive range [seqA, seqB]. */
  range(seqA: number, seqB: number): Cut[];
  latest(): Cut | null;
  resolveRef(ref: CutRef): Cut | undefined;
}

/**
 * In-memory `CutLog` — the reference impl + what Inhuman's single-process use needs.
 * here.build's LogDO will supply a durable impl (DO storage + R2) behind the same interface
 * (the product's server pass). Seqs are strictly increasing (gaps tolerated); timestamps are
 * monotonic (single-writer leader), so time→cut is a binary search.
 */
export class InMemoryCutLog implements CutLog {
  private cuts: Cut[] = []; // sorted by seq (strictly increasing), append-only

  append(cut: Cut): Cut {
    const last = this.cuts[this.cuts.length - 1];
    if (last && cut.seq <= last.seq) {
      throw new Error(`plexus-history: cut seq ${cut.seq} must be strictly increasing (latest ${last.seq})`);
    }
    // Gaps are allowed: a dropped cut (a failed async persist) is a missing frame, not a wedge.
    this.cuts.push(cut);
    return cut;
  }

  /** Binary search for an exact seq; -1 if it's a gap. */
  private indexOfSeq(seq: number): number {
    let lo = 0;
    let hi = this.cuts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.cuts[mid].seq;
      if (s === seq) return mid;
      if (s < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  get(seq: number): Cut | undefined {
    const i = this.indexOfSeq(seq);
    return i >= 0 ? this.cuts[i] : undefined;
  }

  range(seqA: number, seqB: number): Cut[] {
    return this.cuts.filter((c) => c.seq >= seqA && c.seq <= seqB);
  }

  latest(): Cut | null {
    return this.cuts.length > 0 ? this.cuts[this.cuts.length - 1] : null;
  }

  resolveRef(ref: CutRef): Cut | undefined {
    if (typeof ref === "number") return this.get(ref);
    if (ref === "HEAD") return this.latest() ?? undefined;
    if (ref.startsWith("HEAD~")) {
      const head = this.latest();
      if (!head) return undefined;
      return this.get(head.seq - Number(ref.slice(5)));
    }
    if (ref.startsWith("@")) {
      const t = Date.parse(ref.slice(1));
      if (Number.isNaN(t)) return undefined;
      // last cut with timestamp <= t (monotonic ⇒ binary search)
      let lo = 0;
      let hi = this.cuts.length - 1;
      let found: Cut | undefined;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.cuts[mid].timestamp <= t) {
          found = this.cuts[mid];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return found;
    }
    return undefined;
  }
}

// ── Cut persistence codec ─────────────────────────────────────────────────────
// `Cut.afterState` / `deletedRanges` are `Map`s, so a `Cut` is NOT literally JSON-able.
// serialize/deserialize round-trip the Maps (as arrays of pairs) so any store — DO storage,
// a file, Inhuman's own store — can persist + replay cuts.

export interface JsonCut {
  seq: number;
  timestamp: number;
  author: UserSession | null;
  afterState: Array<[number, number]>; // [client, clock]
  deletedRanges: Array<[number, Array<{ clock: number; len: number }>]>; // [client, ranges]
}

export function serializeCut(cut: Cut): JsonCut {
  return {
    seq: cut.seq,
    timestamp: cut.timestamp,
    author: cut.author,
    afterState: [...cut.afterState],
    deletedRanges: [...cut.deletedRanges].map(
      ([client, ranges]): [number, Array<{ clock: number; len: number }>] => [
        client,
        ranges.map((r) => ({ clock: r.clock, len: r.len })),
      ],
    ),
  };
}

export function deserializeCut(json: JsonCut): Cut {
  const afterState: StateVector = new Map(json.afterState);
  const deletedRanges: DeleteRanges = new Map(
    json.deletedRanges.map(
      ([client, ranges]): [number, Array<{ clock: number; len: number }>] => [
        client,
        ranges.map((r) => ({ clock: r.clock, len: r.len })),
      ],
    ),
  );
  return { seq: json.seq, timestamp: json.timestamp, author: json.author, afterState, deletedRanges };
}
