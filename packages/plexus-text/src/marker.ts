import { C } from "./bench/counters.js";
import { isMarker, isTextAtom, Mark, type Marker, type PlexusText, type SeqNode } from "./PlexusText.js";

/**
 * Reading the entity-sequence Peritext model + free-function write wrappers.
 *
 * Offsets are CODE-UNIT (UTF-16) — same units CodeMirror, Lexical, and JS strings
 * index by. Markers are zero-width. Writes go through `@syncing.action` methods on
 * `PlexusText` (one transaction per call).
 */

export type Marks = Record<string, string | boolean | null>;

export interface Segment {
  text: string;
  marks: Marks;
}

/** Plain document string — markers are zero-width. */
export function toText(text: PlexusText): string {
  if (C.on) C.toText++;
  let s = "";
  let scanned = 0;
  for (const n of text.nodes) {
    scanned++;
    if (isTextAtom(n)) s += n.text;
  }
  if (C.on) C.nodesScanned += scanned;
  return s;
}

/**
 * Project the sequence into constant-formatting runs — the editor's marked-leaf view.
 * A mark-keyed ACTIVE-SET: Start adds the Mark, End (same mark entity) removes it —
 * crossing spans pair by intent. Innermost same-type wins via Map insertion order.
 */
export function segments(text: PlexusText): Segment[] {
  if (C.on) C.segments++;
  const active = new Map<Mark, Mark>(); // mark identity → mark
  const out: Segment[] = [];
  let scanned = 0;
  for (const n of text.nodes) {
    scanned++;
    if (isMarker(n)) {
      if (n.open) active.set(n.mark, n.mark);
      else active.delete(n.mark);
      continue;
    }
    if (n.text.length === 0) continue;
    const marks: Marks = {};
    for (const mark of active.values()) marks[mark.type] = mark.value;
    const prev = out[out.length - 1];
    if (prev !== undefined && sameMarks(prev.marks, marks)) prev.text += n.text;
    else out.push({ text: n.text, marks });
  }
  if (C.on) C.nodesScanned += scanned;
  return out;
}

function sameMarks(a: Marks, b: Marks): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

// ── write wrappers (delegate to @syncing.action methods) ───────────────────────

export function addMark(
  text: PlexusText,
  from: number,
  to: number,
  type: string,
  value: string | boolean | null = true,
): void {
  text.addMark(from, to, type, value);
}

export function insertTextAt(text: PlexusText, offset: number, str: string): void {
  text.insertTextAt(offset, str);
}

export function deleteTextRange(text: PlexusText, from: number, to: number): void {
  text.deleteTextRange(from, to);
}

export function removeMark(text: PlexusText, mark: Mark): void {
  text.removeMark(mark);
}

export function unformat(text: PlexusText, from: number, to: number, type: string): void {
  text.unformat(from, to, type);
}

/** A single contiguous replacement — the shape both editor bindings apply inbound. */
export interface TextReplace {
  from: number;
  to: number;
  insert: string;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** Surrogate-safe shared prefix length + shared suffix length of two strings.
 *  Prefix/suffix scan by code unit, then back off any boundary that would split a pair. */
function sharedAffix(before: string, after: string): { p: number; s: number } {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p]) p++;
  if (p > 0 && isHighSurrogate(before.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  if (s > 0 && isLowSurrogate(before.charCodeAt(before.length - s))) s--;
  return { p, s };
}

/** Minimal single-replace diff (shared prefix/suffix) of `before` → `after`, or null.
 *  Prefix/suffix scan by code unit, then back off any boundary that would split a surrogate
 *  pair. Kept as the single-contiguous algorithm — call sites and B6 depend on it. */
export function textDiff(before: string, after: string): TextReplace | null {
  if (before === after) return null;
  const { p, s } = sharedAffix(before, after);
  return { from: p, to: before.length - s, insert: after.slice(p, after.length - s) };
}

/**
 * Multi-hunk minimal replaces of `before` → `after`. Empty array if equal.
 *
 * Algorithm (B7 / N3):
 *  1. Shared prefix/suffix (same as textDiff) peels unchanged ends.
 *  2. Pure insert/delete/replace of the middle → one hunk (equivalent to textDiff).
 *  3. Else try to split the middle:
 *     - containment: midBefore ⊂ midAfter → insert islands (S5 two-site case)
 *     - containment: midAfter ⊂ midBefore → delete islands
 *     - else longest common substring (DP for modest mids) + recurse on flanks,
 *       only when LCS length ≥ MIN_LCS_SPLIT (avoids fragmenting a single edit
 *       region on accidental 1-char matches, e.g. "world" → "there")
 *  4. Fallback: one hunk covering the middle (complex / huge middles).
 *
 * Hunk coordinates refer to `before`. Apply right-to-left (or with offset adjust).
 * Product of mid lengths > MID_DP_CELLS falls back after containment checks only.
 */
const MID_DP_CELLS = 4_000_000;
/** Min contiguous common interior (code units) before LCS-split is worth it. */
const MIN_LCS_SPLIT = 4;

/** Multi-hunk minimal replaces. Empty array if equal. */
export function textDiffs(before: string, after: string): TextReplace[] {
  if (before === after) return [];
  return diffRegion(before, after, 0);
}

function diffRegion(before: string, after: string, base: number): TextReplace[] {
  if (before === after) return [];
  const { p, s } = sharedAffix(before, after);
  const midB = before.slice(p, before.length - s);
  const midA = after.slice(p, after.length - s);
  if (midB === midA) return [];

  // Pure insert, delete, or single contiguous replace of the middle.
  if (midB.length === 0 || midA.length === 0) {
    return [{ from: base + p, to: base + p + midB.length, insert: midA }];
  }

  const split = trySplitMid(midB, midA, base + p);
  if (split !== null && split.length > 0) return split;

  return [{ from: base + p, to: base + p + midB.length, insert: midA }];
}

/**
 * Attempt multi-hunk decomposition of a non-empty mid pair.
 * Returns null to signal "use single hunk covering the whole mid".
 */
function trySplitMid(midB: string, midA: string, base: number): TextReplace[] | null {
  // Containment: whole before-mid is an interior of after-mid → pure inserts around it.
  // Primary S5 path: "xxxx…" → "Axxxx…Z" peels to midB ⊂ midA with inserts at both ends.
  if (midB.length > 0) {
    const idxInA = midA.indexOf(midB);
    if (idxInA !== -1) {
      const left = midA.slice(0, idxInA);
      const right = midA.slice(idxInA + midB.length);
      const hunks: TextReplace[] = [];
      if (left.length > 0) hunks.push({ from: base, to: base, insert: left });
      if (right.length > 0) hunks.push({ from: base + midB.length, to: base + midB.length, insert: right });
      return hunks.length > 0 ? hunks : null;
    }
  }

  // Containment: whole after-mid is an interior of before-mid → pure deletes around it.
  if (midA.length > 0) {
    const idxInB = midB.indexOf(midA);
    if (idxInB !== -1) {
      const hunks: TextReplace[] = [];
      if (idxInB > 0) hunks.push({ from: base, to: base + idxInB, insert: "" });
      const afterCommon = idxInB + midA.length;
      if (afterCommon < midB.length) {
        hunks.push({ from: base + afterCommon, to: base + midB.length, insert: "" });
      }
      return hunks.length > 0 ? hunks : null;
    }
  }

  // General: longest common substring anchor + recurse on left/right flanks.
  // Skip tiny LCS — a 1-char coincidence inside one edit region must stay one hunk
  // so single-region textDiffs ≡ textDiff.
  const lcs = longestCommonSubstring(midB, midA);
  if (lcs === null || lcs.len < MIN_LCS_SPLIT) return null;

  // LCS must leave at least one non-empty flank on either string, else no split gain.
  const leftB = midB.slice(0, lcs.aStart);
  const leftA = midA.slice(0, lcs.bStart);
  const rightB = midB.slice(lcs.aStart + lcs.len);
  const rightA = midA.slice(lcs.bStart + lcs.len);
  if (leftB.length === 0 && leftA.length === 0 && rightB.length === 0 && rightA.length === 0) {
    return null;
  }
  // Degenerate: LCS is the entire mid of one side and the other side only grows/shrinks
  // as a pure prefix/suffix insert — containment above should have caught true ⊂ cases.
  // If LCS equals one full mid, flanks on that side are empty; still recurse.

  const left = diffRegion(leftB, leftA, base);
  const right = diffRegion(rightB, rightA, base + lcs.aStart + lcs.len);
  const combined = left.concat(right);
  // Accept split only when we actually get multiple islands (or any non-empty flank hunks).
  // A single combined hunk is fine — same as fallback but may be more precise in position.
  return combined.length > 0 ? combined : null;
}

/**
 * Longest common *substring* (contiguous). Surrogate-safe boundaries.
 * DP when n*m ≤ MID_DP_CELLS; otherwise a linear-ish chunk heuristic, or null → single hunk.
 */
function longestCommonSubstring(
  a: string,
  b: string,
): { aStart: number; bStart: number; len: number } | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return null;

  if (n * m > MID_DP_CELLS) {
    return longestCommonSubstringHeuristic(a, b);
  }

  let bestA = 0;
  let bestB = 0;
  let bestLen = 0;
  // Rolling two rows of match lengths.
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);

  for (let i = 1; i <= n; i++) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (ai === b.charCodeAt(j - 1)) {
        const len = prev[j - 1]! + 1;
        curr[j] = len;
        if (len > bestLen) {
          bestLen = len;
          bestA = i - len;
          bestB = j - len;
        }
      } else {
        curr[j] = 0;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }

  if (bestLen === 0) return null;
  return trimSurrogateLcs(a, bestA, bestB, bestLen);
}

/**
 * For huge mids: sample fixed-size chunks from the shorter string and locate in the longer.
 * Good enough to recover large shared interiors (batch multi-site) without O(n·m) memory.
 */
function longestCommonSubstringHeuristic(
  a: string,
  b: string,
): { aStart: number; bStart: number; len: number } | null {
  // Prefer searching chunks of the shorter hay/needle pairing.
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const shortIsA = a.length <= b.length;
  const chunk = Math.min(64, short.length);
  if (chunk < 1) return null;

  let bestShort = 0;
  let bestLong = 0;
  let bestLen = 0;

  // Slide chunk window across short; on hit, expand match greedily.
  const step = Math.max(1, Math.floor(chunk / 2));
  for (let i = 0; i + chunk <= short.length; i += step) {
    const piece = short.slice(i, i + chunk);
    let from = 0;
    for (;;) {
      const at = long.indexOf(piece, from);
      if (at < 0) break;
      // Expand left/right from this match.
      let L = 0;
      while (i - L - 1 >= 0 && at - L - 1 >= 0 && short[i - L - 1] === long[at - L - 1]) L++;
      let R = chunk;
      while (i + R < short.length && at + R < long.length && short[i + R] === long[at + R]) R++;
      const len = L + R;
      if (len > bestLen) {
        bestLen = len;
        bestShort = i - L;
        bestLong = at - L;
      }
      from = at + 1;
    }
  }

  if (bestLen === 0) return null;
  const aStart = shortIsA ? bestShort : bestLong;
  const bStart = shortIsA ? bestLong : bestShort;
  return trimSurrogateLcs(a, aStart, bStart, bestLen);
}

/** Shrink an LCS so its endpoints do not sit mid surrogate pair. */
function trimSurrogateLcs(
  a: string,
  aStart: number,
  bStart: number,
  len: number,
): { aStart: number; bStart: number; len: number } | null {
  let s = aStart;
  let t = bStart;
  let n = len;
  // Don't start on a low surrogate (orphaned pair head).
  while (n > 0 && isLowSurrogate(a.charCodeAt(s))) {
    s++;
    t++;
    n--;
  }
  // Don't end on a high surrogate (orphaned pair tail).
  while (n > 0 && isHighSurrogate(a.charCodeAt(s + n - 1))) {
    n--;
  }
  if (n === 0) return null;
  return { aStart: s, bStart: t, len: n };
}

/** Debug / test helper: list nodes with a short label. */
export function describeNodes(text: PlexusText): string[] {
  return text.nodes.map((n: SeqNode) => {
    if (isTextAtom(n)) return `atom:${JSON.stringify(n.text)}`;
    const m = n as Marker;
    return `${m.open ? "start" : "end"}:${m.mark.type}`;
  });
}
