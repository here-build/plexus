import { PlexusModel, syncing } from "@here.build/plexus";

import { C } from "./bench/counters.js";

/**
 * PlexusText — Peritext-style rich text as a pure Plexus entity sequence.
 *
 * The document is one ordered `@syncing.child.list` of nodes: `TextAtom` (characters)
 * interleaved with void `Marker` entities (Start/End of a span). Markers point at a
 * first-class `Mark` (kind + payload) whose UUID is derived from creation — pairing
 * is therefore unique by construction, never minted.
 *
 * No `Y.Text`, no embeds. The public API and tests speak only entities; Yjs is an
 * implementation detail of Plexus. Intent multi-node ops are `@syncing.action` methods.
 *
 * Design: docs/working-proposals/plexustext-implementation-plan.md
 * Formal thesis: docs/working-proposals/plexustext-formal-spec.md
 */

/** Unitary kind tags — JS discriminators, not CRDT keys. */
export const TEXT_ATOM = Symbol.for("plexus-text:atom");
export const MARKER_START = Symbol.for("plexus-text:marker-start");
export const MARKER_END = Symbol.for("plexus-text:marker-end");

/** A formatting / annotation mark — identity (`uuid`) is derived from creation. */
@syncing("PlexusTextMark")
export class Mark extends PlexusModel {
  /** Mark kind — "bold" | "italic" | "link" | "comment" | … */
  @syncing accessor type!: string;
  /** Payload — `true` for a boolean mark, an href for a link, a thread id for a comment. */
  @syncing accessor value!: string | boolean | null;

  constructor(props: { type: string; value?: string | boolean | null }) {
    super({ type: props.type, value: props.value === undefined ? true : props.value });
    if (C.on) C.marksCreated++;
  }
}

/**
 * One text atom in the sequence. Prefer length-1 (or one UTF-16 surrogate pair) so
 * concurrent inserts interleave via the list CRDT rather than LWW a shared string.
 */
@syncing("PlexusTextAtom")
export class TextAtom extends PlexusModel {
  @syncing accessor text!: string;

  constructor(props: { text: string }) {
    super(props);
    if (C.on) C.atomsCreated++;
  }
}

/** Void Start/End boundary pointing at a Mark. Zero width in character space. */
@syncing("PlexusTextMarker")
export class Marker extends PlexusModel {
  /** true = Start, false = End. Pairing key = `mark.uuid`. */
  @syncing accessor open!: boolean;
  /** Non-owning ref to the Mark this boundary points at. */
  @syncing accessor mark!: Mark;

  constructor(props: { open: boolean; mark: Mark }) {
    super(props);
    if (C.on) C.markersCreated++;
  }
}

export type SeqNode = TextAtom | Marker;

export function isTextAtom(n: SeqNode): n is TextAtom {
  return n instanceof TextAtom;
}

export function isMarker(n: SeqNode): n is Marker {
  return n instanceof Marker;
}

// ── N6 B2-lite: local geometry cache (prefix sums over node char lengths) ──────
//
// Not serialized / not CRDT — module-level WeakMap accelerator for listIndexAtOffset.
// Rebuild O(n) when dirty or nodes.length mismatches; binary search O(log n) per query.
// Intent ops update or invalidate the cache so the local keystroke path stays hot.

type GeoCache = {
  /** prefix[i] = UTF-16 code units before nodes[i]; length n+1, prefix[n] = total. */
  prefix: number[];
  /** Per-node char length (0 for markers); length n. */
  lengths: number[];
  n: number;
};

const geoCaches = new WeakMap<PlexusText, GeoCache | "dirty">();

function invalidateGeo(text: PlexusText): void {
  geoCaches.set(text, "dirty");
}

/**
 * Mark the local geometry cache dirty so the next `listIndexAtOffset` rebuilds.
 * Call after remote Y materialization that bypasses local intent ops (P1 observe path).
 * Does not touch Marks, GC, or CRDT state.
 */
export function invalidateListGeometry(text: PlexusText): void {
  invalidateGeo(text);
}

function rebuildGeo(text: PlexusText): GeoCache {
  const nodes = text.nodes;
  const n = nodes.length;
  const prefix = new Array<number>(n + 1);
  const lengths = new Array<number>(n);
  prefix[0] = 0;
  let scanned = 0;
  for (let i = 0; i < n; i++) {
    scanned++;
    const node = nodes[i];
    const len = isTextAtom(node) ? node.text.length : 0;
    lengths[i] = len;
    prefix[i + 1] = prefix[i] + len;
  }
  if (C.on) C.nodesScanned += scanned;
  const geo: GeoCache = { prefix, lengths, n };
  geoCaches.set(text, geo);
  return geo;
}

function ensureGeo(text: PlexusText): GeoCache {
  const hit = geoCaches.get(text);
  if (hit && hit !== "dirty" && hit.n === text.nodes.length) return hit;
  return rebuildGeo(text);
}

/** After splice of `lens` node lengths at `index` (new nodes already in `text.nodes`). */
function geoInsertAt(text: PlexusText, index: number, lens: number[]): void {
  const hit = geoCaches.get(text);
  if (!hit || hit === "dirty") return;
  const k = lens.length;
  if (k === 0) return;
  let added = 0;
  for (let t = 0; t < k; t++) added += lens[t]!;

  // Fast path: append at end — O(k), no shifting.
  if (index === hit.n) {
    let run = hit.prefix[hit.n]!;
    for (let t = 0; t < k; t++) {
      const L = lens[t]!;
      hit.lengths.push(L);
      run += L;
      hit.prefix.push(run);
    }
    hit.n += k;
    return;
  }

  // Mid-insert: splice lengths/prefix then bump the tail by `added`.
  // Plain number[] ops — much cheaper than re-walking MobX entity nodes.
  hit.lengths.splice(index, 0, ...lens);
  // prefix[i] = chars before nodes[i]:
  //   prefix[0..index] unchanged
  //   prefix[index+1 .. index+k] = prefix[index] + running sum of new lens
  //   prefix[index+k+j] = old prefix[index+j] + added  (j >= 1)
  const base = hit.prefix[index]!;
  const inserted: number[] = new Array(k);
  let run = base;
  for (let t = 0; t < k; t++) {
    run += lens[t]!;
    inserted[t] = run;
  }
  hit.prefix.splice(index + 1, 0, ...inserted);
  for (let j = index + k + 1; j < hit.prefix.length; j++) {
    hit.prefix[j]! += added;
  }
  hit.n += k;
}

/**
 * Mid-atom split at list index `i`: left keeps length `leftLen`, right (`leftLen` was
 * part of old atom) is inserted at `i+1` with `rightLen`. Total chars unchanged.
 */
function geoAfterSplit(text: PlexusText, i: number, leftLen: number, rightLen: number): void {
  const hit = geoCaches.get(text);
  if (!hit || hit === "dirty") return;
  hit.lengths[i] = leftLen;
  hit.lengths.splice(i + 1, 0, rightLen);
  // prefix[i] unchanged; new prefix[i+1] = prefix[i] + leftLen; later prefixes unchanged
  // (length only redistributed).
  hit.prefix.splice(i + 1, 0, hit.prefix[i]! + leftLen);
  hit.n += 1;
}

@syncing("PlexusText")
export class PlexusText extends PlexusModel {
  /** The document sequence — sole ordered store of atoms and void markers. */
  @syncing.child.list accessor nodes: SeqNode[] = [];
  /** Marks owned here; marker nodes point at them by entity ref. */
  @syncing.child.set accessor marks: Set<Mark> = new Set();

  constructor(props: { nodes?: SeqNode[]; marks?: Set<Mark> } = {}) {
    super({
      nodes: props.nodes ?? [],
      marks: props.marks ?? new Set(),
    });
  }

  // ── intent surface: one transaction per call ─────────────────────────────────

  /** Insert `str` at character `offset` (UTF-16 code units). */
  @syncing.action
  insertTextAt(offset: number, str: string): void {
    if (str.length === 0) return;
    const index = this.listIndexAtOffset(Math.max(0, offset));
    const atoms = atomsFromString(str);
    if (atoms.length === 0) return;
    this.nodes.splice(index, 0, ...atoms);
    geoInsertAt(
      this,
      index,
      atoms.map((a) => a.text.length),
    );
  }

  /**
   * Delete text in [from, to), collapsing onto markers.
   * Marker nodes in the range are preserved; only TextAtoms are removed/truncated.
   */
  @syncing.action
  deleteTextRange(from: number, to: number): void {
    if (to <= from || to <= 0) return;
    const lo = Math.max(0, from);
    const hi = to;
    // Collect atom edits high→low so earlier removals don't shift later indices.
    type Edit = { index: number; kind: "remove" } | { index: number; kind: "trim"; text: string };
    const edits: Edit[] = [];
    let chars = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (!isTextAtom(n)) continue;
      const start = chars;
      const end = chars + n.text.length;
      chars = end;
      if (end <= lo || start >= hi) continue;
      const keepLeft = Math.max(0, lo - start);
      const keepRight = Math.max(0, end - hi);
      if (keepLeft === 0 && keepRight === 0) {
        edits.push({ index: i, kind: "remove" });
      } else {
        const left = n.text.slice(0, keepLeft);
        const right = n.text.slice(n.text.length - keepRight);
        edits.push({ index: i, kind: "trim", text: left + right });
      }
    }
    for (let e = edits.length - 1; e >= 0; e--) {
      const edit = edits[e];
      if (edit.kind === "remove") this.nodes.splice(edit.index, 1);
      else if (edit.text.length === 0) this.nodes.splice(edit.index, 1);
      else (this.nodes[edit.index] as TextAtom).text = edit.text;
    }
    // Node list and/or atom lengths changed — drop geometry (rebuild on next query).
    invalidateGeo(this);
  }

  /**
   * Add a span over [from, to): create Mark, insert Start at `from` and End at `to`.
   * Does not GC anything.
   */
  @syncing.action
  addMark(from: number, to: number, type: string, value: string | boolean | null = true): void {
    const mark = new Mark({ type, value });
    this.marks.add(mark);
    // End first — at/after `from`, so it does not shift the open's list index.
    const iTo = this.listIndexAtOffset(Math.max(from, to));
    this.nodes.splice(iTo, 0, new Marker({ open: false, mark }));
    geoInsertAt(this, iTo, [0]);
    const iFrom = this.listIndexAtOffset(Math.min(from, to));
    this.nodes.splice(iFrom, 0, new Marker({ open: true, mark }));
    geoInsertAt(this, iFrom, [0]);
  }

  /**
   * Spec-shaped: delete this Mark's Start+End pair from the sequence.
   * Does NOT remove the Mark entity from `marks` (GC is out of scope).
   */
  @syncing.action
  removeMark(mark: Mark): void {
    let removed = false;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (isMarker(n) && n.mark === mark) {
        this.nodes.splice(i, 1);
        removed = true;
      }
    }
    if (removed) invalidateGeo(this);
  }

  /**
   * Range-addressed unformat: remove `type` formatting over [from, to).
   * Fully covered spans → removeMark; partial → split (close+reopen at edges).
   * Does not GC Mark entities.
   */
  @syncing.action
  unformat(from: number, to: number, type: string): void {
    if (to <= from) return;
    // Snapshot spans of this type that intersect [from, to).
    const spans = this.spansOfType(type).filter((s) => s.from < to && s.to > from);
    // Process high→low so splits don't disturb earlier indices.
    spans.sort((a, b) => b.from - a.from);
    for (const span of spans) {
      const coverFrom = Math.max(span.from, from);
      const coverTo = Math.min(span.to, to);
      if (coverFrom >= coverTo) continue;
      const fully = coverFrom <= span.from && coverTo >= span.to;
      if (fully) {
        this.removeMark(span.mark);
        continue;
      }
      // Split: keep mark on the non-covered parts.
      // Remove original pair, re-add on residual ranges with same type/value.
      const { mark } = span;
      const value = mark.value;
      const t = mark.type;
      this.removeMark(mark);
      if (span.from < coverFrom) this.addMark(span.from, coverFrom, t, value);
      if (coverTo < span.to) this.addMark(coverTo, span.to, t, value);
    }
  }

  // ── internal geometry ────────────────────────────────────────────────────────

  /**
   * List index at which content for character `offset` begins (or `nodes.length`
   * if past the end). Markers are zero-width. If offset falls mid-atom, the atom
   * is split so the returned index sits on a boundary.
   *
   * N6: O(log n) via prefix-sum cache + binary search (rebuild O(n) when dirty).
   */
  listIndexAtOffset(offset: number): number {
    if (C.on) C.listIndexAtOffset++;
    // At most one rebuild retry if a length desync is detected on the landed atom.
    for (let attempt = 0; attempt < 2; attempt++) {
      const nodes = this.nodes;
      const n = nodes.length;
      if (n === 0) return 0;

      const geo = ensureGeo(this);
      const { prefix, lengths } = geo;
      const total = prefix[n]!;
      // Strict past-end only. offset === total is the boundary after the last atom
      // (before any trailing markers) — same as the linear scan's chars===offset path.
      if (offset > total) {
        if (C.on) C.nodesScanned += 1;
        return n;
      }
      if (offset === total) {
        // After last positive-length atom (or n if none).
        let i = n - 1;
        let scanned = 0;
        while (i >= 0 && lengths[i] === 0) {
          scanned++;
          i--;
        }
        if (C.on) C.nodesScanned += scanned + 1;
        return i < 0 ? n : i + 1;
      }

      // Binary search: largest index with prefix[i] <= offset.
      let lo = 0;
      let hi = n - 1;
      let scanned = 0;
      while (lo < hi) {
        scanned++;
        const mid = (lo + hi + 1) >> 1;
        if (prefix[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }

      // Walk back over zero-width markers to the covering atom.
      let i = lo;
      while (i >= 0 && lengths[i] === 0) {
        scanned++;
        i--;
      }
      if (i < 0) {
        // Should not happen when total > offset (there is at least one atom).
        if (C.on) C.nodesScanned += scanned;
        return 0;
      }

      const node = nodes[i]!;
      // Opportunistic length check — if atom text drifted (e.g. remote trim), rebuild once.
      if (isTextAtom(node) && node.text.length !== lengths[i]) {
        rebuildGeo(this);
        continue;
      }
      if (!isTextAtom(node) && lengths[i]! !== 0) {
        invalidateGeo(this);
        continue;
      }

      const start = prefix[i]!;
      const len = lengths[i]!;
      scanned++; // account for landing on this node

      if (start + len > offset) {
        const at = offset - start;
        if (at <= 0) {
          // Atom starts at `offset`.
          // offset === 0: first atom (skip leading markers) — return i.
          // offset > 0: earliest list index at this char boundary (include markers
          // after the previous atom that ended here) — walk left while prefix matches.
          if (offset === 0) {
            if (C.on) C.nodesScanned += scanned;
            return i;
          }
          let j = i;
          while (j > 0 && prefix[j - 1]! === offset) {
            scanned++;
            j--;
          }
          if (C.on) C.nodesScanned += scanned;
          return j;
        }
        // Split mid-atom so insert lands between characters.
        if (!isTextAtom(node)) {
          invalidateGeo(this);
          continue;
        }
        const left = node.text.slice(0, at);
        const right = node.text.slice(at);
        node.text = left;
        this.nodes.splice(i + 1, 0, new TextAtom({ text: right }));
        geoAfterSplit(this, i, left.length, right.length);
        if (C.on) C.nodesScanned += scanned;
        return i + 1;
      }

      // Atom ends exactly at offset (start + len === offset).
      if (C.on) C.nodesScanned += scanned;
      return i + 1;
    }
    // Exhausted retries — fall back to a full linear scan (should be unreachable).
    return this.listIndexAtOffsetLinear(offset);
  }

  /** Linear fallback kept for desync recovery; not on the hot path. */
  private listIndexAtOffsetLinear(offset: number): number {
    let chars = 0;
    let scanned = 0;
    let result = this.nodes.length;
    for (let i = 0; i < this.nodes.length; i++) {
      scanned++;
      const n = this.nodes[i];
      if (!isTextAtom(n)) continue;
      if (chars + n.text.length > offset) {
        const at = offset - chars;
        if (at <= 0) {
          result = i;
          break;
        }
        const left = n.text.slice(0, at);
        const right = n.text.slice(at);
        n.text = left;
        this.nodes.splice(i + 1, 0, new TextAtom({ text: right }));
        result = i + 1;
        break;
      }
      chars += n.text.length;
      if (chars === offset) {
        result = i + 1;
        break;
      }
    }
    invalidateGeo(this);
    if (C.on) C.nodesScanned += scanned;
    return result;
  }

  /** Projected [from,to) character ranges for each Mark of `type` currently in the sequence. */
  spansOfType(type: string): { mark: Mark; from: number; to: number }[] {
    if (C.on) C.spansOfType++;
    const openAt = new Map<Mark, number>();
    const out: { mark: Mark; from: number; to: number }[] = [];
    let chars = 0;
    let scanned = 0;
    for (const n of this.nodes) {
      scanned++;
      if (isMarker(n)) {
        if (n.open) {
          if (n.mark.type === type) openAt.set(n.mark, chars);
        } else {
          const from = openAt.get(n.mark);
          if (from !== undefined) {
            out.push({ mark: n.mark, from, to: chars });
            openAt.delete(n.mark);
          }
        }
      } else {
        chars += n.text.length;
      }
    }
    if (C.on) C.nodesScanned += scanned;
    return out;
  }
}

/** Split a string into atoms: one UTF-16 code unit, or one surrogate pair, per atom. */
export function atomsFromString(str: string): TextAtom[] {
  const out: TextAtom[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out.push(new TextAtom({ text: str.slice(i, i + 2) }));
        i++;
        continue;
      }
    }
    out.push(new TextAtom({ text: str[i] }));
  }
  return out;
}
