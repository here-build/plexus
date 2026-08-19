import type { Plexus, PlexusAwareness } from "@here.build/plexus";
import {
  addMark,
  deleteTextRange,
  type EditorUser,
  insertTextAt,
  type Marks,
  observePlexusText,
  type PlexusText,
  type Segment,
  type SelectionPresence,
  segments,
  textDiff,
  textDiffs,
  type TextEvent,
  type TextPresence,
  type TextReplace,
  textEventsToReplaces,
  toText,
  unformat,
  colorForClientId,
} from "@here.build/plexus-text";
import { C } from "@here.build/plexus-text/bench";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COLLABORATION_TAG,
  type ElementNode,
  type LexicalEditor,
  type TextFormatType,
  type TextNode,
} from "lexical";
import { reaction } from "mobx";
import * as Y from "yjs";

/**
 * Lexical binding for PlexusText — collaborative inline rich text.
 *
 * Membrane principle (anti-Yjs-full-rebuild):
 * - Outbound: editor state → textDiffs / formatDiff → intent ops on the model
 * - Inbound P0: model projection → textDiffs / formatDiff → **minimal** Lexical edits
 * - Inbound P1: Y.Array observe → TextEvent → O(d) Lexical range ops (no toText on live path)
 * - Never clear-and-rebuild the paragraph for a remote keystroke.
 *
 * N1 coalesce: MobX reaction scheduler batches O(N) invalidations; doc.on("update")
 *   drains pending reaction sync at end of Y apply → pulls === 1 per remote batch.
 *   (P0 path only.)
 * N2 one projection: tracking computes toText+segments once; pull reuses that cache.
 * N3 multi-hunk: textDiffs applied end→start (before-coords stay valid).
 * N4 time-slice: large hunk sets yield between batches; small pulls stay sync.
 * N5 format memo: when projection fmt fingerprint matches last applied, skip
 *   editor format walk (text-only remotes).
 *
 * P1 (fork b): observePlexusText on nodes Y.Array; one event batch → one apply;
 *   markers-changed → formatDiff only; resync / forced full agree uses P0 pull once.
 */

/**
 * Tag on inbound collab updates (`lexical.COLLABORATION_TAG` = `"collaboration"`).
 *
 * Note (Lexical 0.45 / eng-review G5): `@lexical/history` only auto-discards
 * `HISTORIC_TAG`, not collaboration. After an inbound apply we also dispatch
 * `CLEAR_HISTORY_COMMAND` so undo cannot revert CRDT-applied state.
 */
export const COLLAB_TAG = COLLABORATION_TAG;

const FORMAT_TYPES = ["bold", "italic", "code"] as const;
type FormatType = (typeof FORMAT_TYPES)[number];

const MARK_TO_FORMAT: Record<FormatType, TextFormatType> = {
  bold: "bold",
  italic: "italic",
  code: "code",
};

/** N4: yield between batches when total replace work or hunk count is large. */
const TIME_SLICE_CHARS = 8000;
const TIME_SLICE_HUNKS = 32;
const HUNK_CHUNK = 8;

type Projection = {
  key: string;
  body: string;
  /** Mark-structure fingerprint (lengths of marked runs) — N5 format memo. */
  fmt: string;
  segs: Segment[];
};

function fmtFingerprint(segs: Segment[]): string {
  let fmt = "";
  for (const s of segs) {
    const keys = Object.keys(s.marks).sort();
    if (keys.length) fmt += `${s.text.length}:{${keys.join(",")}};`;
  }
  return fmt;
}

function computeProjection(text: PlexusText): Projection {
  const body = toText(text);
  const segs = segments(text);
  const fmt = fmtFingerprint(segs);
  return { key: body + "\0" + fmt, body, fmt, segs };
}

function totalHunkWork(hunks: TextReplace[]): number {
  let w = 0;
  for (const h of hunks) w += h.to - h.from + h.insert.length;
  return w;
}

function shouldTimeSlice(hunks: TextReplace[]): boolean {
  return hunks.length > TIME_SLICE_HUNKS || totalHunkWork(hunks) > TIME_SLICE_CHARS;
}

/** Descending `from` so sequential apply keeps before-coords valid. */
function hunksDescending(hunks: TextReplace[]): TextReplace[] {
  return hunks.length <= 1 ? hunks : [...hunks].sort((a, b) => b.from - a.from || b.to - a.to);
}

// ── geometry: document offset ↔ Lexical text-node point ────────────────────────

type Point = { key: string; offset: number };

/** Walk the single paragraph's text nodes; map a UTF-16 offset to a Lexical point. */
function offsetToPoint(offset: number): Point | null {
  const p = $getRoot().getFirstChild();
  if (p === null || !$isElement(p)) return null;
  let pos = 0;
  let last: Point | null = null;
  for (const child of p.getChildren()) {
    if (!$isTextNode(child)) continue;
    const len = child.getTextContentSize();
    last = { key: child.getKey(), offset: len };
    if (pos + len >= offset) {
      return { key: child.getKey(), offset: Math.max(0, offset - pos) };
    }
    pos += len;
  }
  // Past end → clamp to last text node end, or null if empty.
  return last;
}

function $isElement(n: unknown): n is ElementNode {
  return typeof n === "object" && n !== null && "getChildren" in (n as object);
}

/** Ensure a single empty paragraph exists (initial empty doc only). */
function ensureParagraph(): ElementNode {
  const root = $getRoot();
  const existing = root.getFirstChild();
  if (existing !== null && $isElement(existing)) {
    return existing;
  }
  root.clear();
  const p = $createParagraphNode();
  root.append(p);
  return p;
}

/**
 * Apply a single TextReplace to the current Lexical tree without rebuilding.
 * Selection after the op sits at `from + insert.length` (editor-native caret behavior).
 */
function applyTextReplace(diff: TextReplace): void {
  const p = ensureParagraph();
  // Empty editor: just append.
  if (p.getChildrenSize() === 0) {
    if (diff.insert.length > 0) p.append($createTextNode(diff.insert));
    return;
  }

  const anchor = offsetToPoint(diff.from);
  const focus = offsetToPoint(diff.to);
  if (anchor === null || focus === null) {
    // Degenerate tree (non-text kids / empty mid-state): select all existing text
    // leaves and insertText — never p.clear() (eng-review live-path bomb).
    let firstKey: string | null = null;
    let lastKey: string | null = null;
    let lastLen = 0;
    for (const child of p.getChildren()) {
      if (!$isTextNode(child)) continue;
      if (firstKey === null) firstKey = child.getKey();
      lastKey = child.getKey();
      lastLen = child.getTextContentSize();
    }
    if (firstKey === null || lastKey === null) {
      if (diff.insert.length > 0) p.append($createTextNode(diff.insert));
      return;
    }
    const all = $createRangeSelection();
    all.anchor.set(firstKey, 0, "text");
    all.focus.set(lastKey, lastLen, "text");
    $setSelection(all);
    const liveAll = $getSelection();
    if ($isRangeSelection(liveAll)) liveAll.insertText(diff.insert);
    return;
  }

  const sel = $createRangeSelection();
  sel.anchor.set(anchor.key, anchor.offset, "text");
  sel.focus.set(focus.key, focus.offset, "text");
  $setSelection(sel);
  const live = $getSelection();
  if ($isRangeSelection(live)) {
    // insertText replaces the selected range (delete+insert in one op).
    live.insertText(diff.insert);
  }
}

// ── format ranges ──────────────────────────────────────────────────────────────

type Range = { from: number; to: number };

function rangesWith(segs: Segment[], type: string): Range[] {
  const raw: Range[] = [];
  let offset = 0;
  for (const s of segs) {
    if (s.marks[type]) raw.push({ from: offset, to: offset + s.text.length });
    offset += s.text.length;
  }
  if (raw.length === 0) return raw;
  const merged: Range[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (last.to === raw[i].from) last.to = raw[i].to;
    else merged.push(raw[i]);
  }
  return merged;
}

function subtractRanges(a: Range[], b: Range[]): Range[] {
  if (a.length === 0) return [];
  if (b.length === 0) return a.map((r) => ({ ...r }));
  const out: Range[] = [];
  for (const ar of a) {
    let pieces: Range[] = [{ from: ar.from, to: ar.to }];
    for (const br of b) {
      const next: Range[] = [];
      for (const p of pieces) {
        if (br.to <= p.from || br.from >= p.to) {
          next.push(p);
          continue;
        }
        if (br.from > p.from) next.push({ from: p.from, to: br.from });
        if (br.to < p.to) next.push({ from: br.to, to: p.to });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out.filter((r) => r.to > r.from);
}

function sameMarks(a: Marks, b: Marks): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

/** Toggle a format over [from,to) by selecting the range and applying formatText. */
function applyFormatRange(from: number, to: number, format: TextFormatType): void {
  if (to <= from) return;
  const a = offsetToPoint(from);
  const b = offsetToPoint(to);
  if (a === null || b === null) return;
  const sel = $createRangeSelection();
  sel.anchor.set(a.key, a.offset, "text");
  sel.focus.set(b.key, b.offset, "text");
  $setSelection(sel);
  const live = $getSelection();
  if ($isRangeSelection(live)) live.formatText(format);
}

function readEditorSegmentsInUpdate(): Segment[] {
  const p = $getRoot().getFirstChild();
  if (p === null || !$isElement(p)) return [];
  const out: Segment[] = [];
  for (const child of p.getChildren()) {
    if (!$isTextNode(child)) continue;
    const t = child.getTextContent();
    if (t.length === 0) continue;
    const marks: Marks = {};
    for (const type of FORMAT_TYPES) {
      if (child.hasFormat(MARK_TO_FORMAT[type])) marks[type] = true;
    }
    const prev = out[out.length - 1];
    if (prev !== undefined && sameMarks(prev.marks, marks)) prev.text += t;
    else out.push({ text: t, marks });
  }
  return out;
}

/** Apply format range deltas inside an already-open editor.update. Returns if any op ran. */
function applyFormatDiffInUpdate(modelSegs: Segment[]): boolean {
  const edSegs = readEditorSegmentsInUpdate();
  let changed = false;

  const caret = $getSelection();
  let caretAnchor: Point | null = null;
  let caretFocus: Point | null = null;
  if ($isRangeSelection(caret)) {
    caretAnchor = { key: caret.anchor.key, offset: caret.anchor.offset };
    caretFocus = { key: caret.focus.key, offset: caret.focus.offset };
  }

  for (const type of FORMAT_TYPES) {
    const want = rangesWith(modelSegs, type);
    const have = rangesWith(edSegs, type);
    const fmt = MARK_TO_FORMAT[type];
    for (const r of subtractRanges(want, have)) {
      applyFormatRange(r.from, r.to, fmt);
      changed = true;
    }
    for (const r of subtractRanges(have, want)) {
      applyFormatRange(r.from, r.to, fmt); // toggle off
      changed = true;
    }
  }

  if (caretAnchor && caretFocus) {
    try {
      const sel = $createRangeSelection();
      sel.anchor.set(caretAnchor.key, caretAnchor.offset, "text");
      sel.focus.set(caretFocus.key, caretFocus.offset, "text");
      $setSelection(sel);
    } catch {
      /* node keys may have been split by format — leave Lexical's default */
    }
  }
  return changed;
}

// ── inbound: model → editor (minimal) ──────────────────────────────────────────

/**
 * Project model → editor with the smallest possible Lexical ops.
 * - Text: multi-hunk TextReplace via selection+insertText (caret-native), end→start
 * - Format: only the range deltas that differ (skipped when N5 fmt fingerprint matches)
 * Returns whether anything was applied.
 *
 * When `projected` is provided (N2), skips re-calling toText/segments.
 * When `skipFormat` (N5), skips editor format walk entirely.
 *
 * Sync path only — large time-sliced applies go through `runPull` continuations.
 */
function pullMinimalSync(
  editor: LexicalEditor,
  text: PlexusText,
  projected: Projection | undefined,
  skipFormat: boolean,
  orderedHunks: TextReplace[],
): boolean {
  let changed = false;
  editor.update(
    () => {
      for (const h of orderedHunks) {
        applyTextReplace(h);
        changed = true;
      }

      if (!skipFormat) {
        const modelSegs = projected?.segs ?? segments(text);
        if (applyFormatDiffInUpdate(modelSegs)) changed = true;
      }
    },
    { tag: COLLAB_TAG, discrete: true },
  );
  return changed;
}

/** Initial load only — empty editor, full content once. Still segment-based, one pass. */
function seedEditor(editor: LexicalEditor, text: PlexusText): void {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      root.append(p);
      for (const seg of segments(text)) {
        const node = $createTextNode(seg.text);
        for (const mark of Object.keys(seg.marks)) {
          const fmt = MARK_TO_FORMAT[mark as FormatType];
          if (fmt !== undefined && seg.marks[mark]) node.toggleFormat(fmt);
        }
        p.append(node);
      }
    },
    { tag: COLLAB_TAG, discrete: true },
  );
}

// ── outbound ────────────────────────────────────────────────────────────────────

function editorSegments(editor: LexicalEditor): Segment[] {
  return editor.getEditorState().read(() => {
    const p = $getRoot().getFirstChild() as ElementNode | null;
    if (p === null) return [];
    const out: Segment[] = [];
    for (const child of p.getChildren()) {
      if (!$isTextNode(child)) continue;
      const t = (child as TextNode).getTextContent();
      if (t.length === 0) continue;
      const marks: Marks = {};
      for (const type of FORMAT_TYPES) {
        if ((child as TextNode).hasFormat(MARK_TO_FORMAT[type])) marks[type] = true;
      }
      const prev = out[out.length - 1];
      if (prev !== undefined && sameMarks(prev.marks, marks)) prev.text += t;
      else out.push({ text: t, marks });
    }
    return out;
  });
}

function syncText(editor: LexicalEditor, text: PlexusText): void {
  const editorText = editor.getEditorState().read(() => $getRoot().getTextContent());
  const hunks = textDiffs(toText(text), editorText);
  // Before-coords → apply high→low so later (lower) hunks stay valid.
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i];
    if (h.to > h.from) deleteTextRange(text, h.from, h.to);
    if (h.insert.length > 0) insertTextAt(text, h.from, h.insert);
  }
}

function syncFormats(editor: LexicalEditor, text: PlexusText): void {
  const edSegs = editorSegments(editor);
  const modelSegs = segments(text);
  for (const type of FORMAT_TYPES) {
    const want = rangesWith(edSegs, type);
    const have = rangesWith(modelSegs, type);
    for (const r of subtractRanges(want, have)) addMark(text, r.from, r.to, type, true);
    for (const r of subtractRanges(have, want)) unformat(text, r.from, r.to, type);
  }
}

function syncOutbound(editor: LexicalEditor, text: PlexusText): void {
  syncText(editor, text);
  syncFormats(editor, text);
}

function readLocalSelection(editor: LexicalEditor): SelectionPresence | null {
  return editor.getEditorState().read(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return null;
    const anchorKey = sel.anchor.key;
    const focusKey = sel.focus.key;
    const anchorOffset = sel.anchor.offset;
    const focusOffset = sel.focus.offset;

    let anchor = 0;
    let head = 0;
    let seenA = false;
    let seenH = false;
    let pos = 0;
    const p = $getRoot().getFirstChild() as ElementNode | null;
    if (p === null) return { anchor: 0, head: 0 };
    for (const child of p.getChildren()) {
      if (!$isTextNode(child)) continue;
      const len = (child as TextNode).getTextContentSize();
      if (child.getKey() === anchorKey) {
        anchor = pos + anchorOffset;
        seenA = true;
      }
      if (child.getKey() === focusKey) {
        head = pos + focusOffset;
        seenH = true;
      }
      pos += len;
    }
    if (!seenA || !seenH) return null;
    return { anchor, head };
  });
}

/** Remote selection snapshot for UI / tests (Lexical has no built-in caret layer). */
export type RemoteSelection = {
  peerId: number;
  selection: SelectionPresence;
  user?: EditorUser;
  color: string;
};

/** Projector mode — P1 uses structured Y.Array events; P0 is textDiff fallback. */
export type ProjectorMode = "auto" | "p0" | "p1";

export type BindLexicalOptions = {
  doc: Y.Doc;
  plexus?: Plexus<PlexusText>;
  awareness?: PlexusAwareness;
  user?: EditorUser;
  /** Called whenever remote selections change (paint carets in your React layer). */
  onRemoteSelections?: (remotes: RemoteSelection[]) => void;
  /**
   * Inbound projector. Default `"auto"`: P1 if `observePlexusText` succeeds, else P0.
   * Tests may pin `"p0"` | `"p1"`.
   */
  projector?: ProjectorMode;
  /** Fired when P1 geometry desyncs and the binding falls back to one P0 pull. */
  onResync?: (reason: string) => void;
};

function resolveOpts(docOrOpts: Y.Doc | BindLexicalOptions): BindLexicalOptions {
  if (docOrOpts && typeof docOrOpts === "object" && "doc" in docOrOpts && (docOrOpts as BindLexicalOptions).doc) {
    return docOrOpts as BindLexicalOptions;
  }
  return { doc: docOrOpts as Y.Doc };
}

function collectRemoteSelections(awareness: PlexusAwareness, localId: number): RemoteSelection[] {
  const out: RemoteSelection[] = [];
  for (const peerId of awareness.getPeerIds()) {
    if (peerId === localId) continue;
    const peer = awareness.getPeer(peerId) as TextPresence | null;
    if (!peer?.selection) continue;
    out.push({
      peerId,
      selection: peer.selection,
      user: peer.user,
      color: peer.user?.color ?? colorForClientId(peerId),
    });
  }
  return out;
}

/** Two-way-bind a Lexical editor to a PlexusText. Returns an unbind function. */
export function bindLexical(
  editor: LexicalEditor,
  text: PlexusText,
  docOrOpts: Y.Doc | BindLexicalOptions,
): () => void {
  const opts = resolveOpts(docOrOpts);
  const { user, onRemoteSelections } = opts;
  const plexus = opts.plexus;
  const awareness = opts.awareness ?? plexus?.awareness;
  const localId = awareness?.doc.clientID ?? opts.doc.clientID;
  const projectorPref: ProjectorMode = opts.projector ?? "auto";
  const onResync = opts.onResync;

  let applying = false;
  let pending = false;
  /** Last projection from MobX tracking (N2 reuse inside pull, P0). */
  let lastProjection: Projection | null = null;
  /** N5: last fmt fingerprint applied to the editor (skip format walk when equal). */
  let lastAppliedFmt: string | null = null;
  let reactionRunner: (() => void) | null = null;
  let reactionMicrotaskQueued = false;
  /** Bumps on unbind to cancel in-flight N4 slices. */
  let sliceGen = 0;

  // One-time seed (empty editor → model). After this, only minimal diffs.
  seedEditor(editor, text);
  {
    const seedProj = computeProjection(text);
    lastAppliedFmt = seedProj.fmt;
  }

  if (awareness && user) {
    awareness.setField("user" as never, user as never);
  }

  const finishPull = (changed: boolean, appliedFmt: string | null): void => {
    if (appliedFmt !== null) lastAppliedFmt = appliedFmt;
    // Multiplayer: drop local undo stack after remote content lands so Ctrl+Z
    // cannot revert CRDT-applied state (HistoryPlugin does not skip COLLABORATION_TAG).
    if (changed) {
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    }
    applying = false;
    if (pending) {
      pending = false;
      lastProjection = null;
      runPull();
    }
  };

  /** P0 full pull: toText + textDiffs. Used for seed-agree, resync, and pure P0 mode. */
  const runPull = (): void => {
    if (applying) {
      pending = true;
      return;
    }
    if (C.on) C.pulls++;
    applying = true;

    const projected = lastProjection ?? computeProjection(text);
    const editorText = editor.getEditorState().read(() => $getRoot().getTextContent());
    const hunks = textDiffs(editorText, projected.body);
    const ordered = hunksDescending(hunks);
    // N5: skip editor format walk when mark fingerprint unchanged since last apply.
    const skipFormat = lastAppliedFmt !== null && projected.fmt === lastAppliedFmt;
    const nextFmt = skipFormat ? null : projected.fmt;

    if (ordered.length === 0) {
      // Format-only (or no-op) remote.
      if (skipFormat) {
        finishPull(false, null);
        return;
      }
      const changed = pullMinimalSync(editor, text, projected, false, []);
      finishPull(changed, nextFmt);
      return;
    }

    if (!shouldTimeSlice(ordered)) {
      const changed = pullMinimalSync(editor, text, projected, skipFormat, ordered);
      finishPull(changed, nextFmt);
      return;
    }

    // N4 large path: text hunks in descending chunks; format + CLEAR_HISTORY once at end.
    const gen = sliceGen;
    let idx = 0;
    let anyChanged = false;
    const step = (): void => {
      if (gen !== sliceGen) return;
      const end = Math.min(idx + HUNK_CHUNK, ordered.length);
      const batch = ordered.slice(idx, end);
      const isLast = end >= ordered.length;
      editor.update(
        () => {
          for (const h of batch) {
            applyTextReplace(h);
            anyChanged = true;
          }
          if (isLast && !skipFormat) {
            const modelSegs = projected.segs;
            if (applyFormatDiffInUpdate(modelSegs)) anyChanged = true;
          }
        },
        { tag: COLLAB_TAG, discrete: true },
      );
      idx = end;
      if (!isLast) {
        queueMicrotask(step);
      } else {
        finishPull(anyChanged, nextFmt);
      }
    };
    step();
  };

  // ── P1 structured events ───────────────────────────────────────────────────
  const applyP1Events = (events: TextEvent[]): void => {
    // Self-echo: local outbound holds `applying` through the Y afterTransaction
    // that delivers these events — editor already has the text; drop without
    // scheduling a P0 pull (that would reintroduce toText on every keystroke).
    if (applying) return;

    const { replaces, resync, markersChanged, resyncReason } = textEventsToReplaces(events);
    if (resync) {
      onResync?.(resyncReason ?? "p1-resync");
      lastProjection = null;
      runPull();
      return;
    }

    // markers-changed → formatDiff; text ops also re-diff format after apply so
    // concurrent mark+insert peers converge (insertText inheritance ≠ CRDT mark
    // geometry). formatDiff uses segments() only — never toText on the live path.
    if (replaces.length === 0 && !markersChanged) return;

    if (C.on) C.pulls++;
    applying = true;

    /** Sequential model coords → sequential applyTextReplace (not same-doc reverse). */
    const applyReplacesInUpdate = (hunks: TextReplace[]): boolean => {
      let changed = false;
      for (const h of hunks) {
        applyTextReplace(h);
        changed = true;
      }
      return changed;
    };

    const applyFormatAndFingerprint = (): { changed: boolean; nextFmt: string } => {
      const modelSegs = segments(text);
      const changed = applyFormatDiffInUpdate(modelSegs);
      return { changed, nextFmt: fmtFingerprint(modelSegs) };
    };

    if (replaces.length === 0) {
      // markers-changed only — formatDiff path, no text ops.
      let changed = false;
      let nextFmt: string | null = null;
      editor.update(
        () => {
          const r = applyFormatAndFingerprint();
          changed = r.changed;
          nextFmt = r.nextFmt;
        },
        { tag: COLLAB_TAG, discrete: true },
      );
      finishPull(changed, nextFmt);
      return;
    }

    if (!shouldTimeSlice(replaces)) {
      let changed = false;
      let nextFmt: string | null = null;
      editor.update(
        () => {
          if (applyReplacesInUpdate(replaces)) changed = true;
          const r = applyFormatAndFingerprint();
          if (r.changed) changed = true;
          nextFmt = r.nextFmt;
        },
        { tag: COLLAB_TAG, discrete: true },
      );
      finishPull(changed, nextFmt);
      return;
    }

    // N4: still sequential (coords depend on prior); yield between chunks.
    // Format reconcile once at end (after all text coords are applied).
    const gen = sliceGen;
    let idx = 0;
    let anyChanged = false;
    const step = (): void => {
      if (gen !== sliceGen) return;
      const end = Math.min(idx + HUNK_CHUNK, replaces.length);
      const batch = replaces.slice(idx, end);
      const isLast = end >= replaces.length;
      let nextFmt: string | null = null;
      editor.update(
        () => {
          if (applyReplacesInUpdate(batch)) anyChanged = true;
          if (isLast) {
            const r = applyFormatAndFingerprint();
            if (r.changed) anyChanged = true;
            nextFmt = r.nextFmt;
          }
        },
        { tag: COLLAB_TAG, discrete: true },
      );
      idx = end;
      if (!isLast) {
        queueMicrotask(step);
      } else {
        finishPull(anyChanged, nextFmt);
      }
    };
    step();
  };

  let disposeP1: (() => void) | null = null;
  let useP1 = false;

  if (projectorPref !== "p0") {
    disposeP1 = observePlexusText(text, applyP1Events, { doc: opts.doc });
    if (disposeP1) {
      useP1 = true;
    } else if (projectorPref === "p1") {
      // Forced P1 unavailable — fall back to P0 rather than silent stall.
      useP1 = false;
    }
  }

  // ── P0 observation (MobX + doc update) — skipped when P1 is live ───────────
  let disposeReaction: (() => void) | null = null;
  let onDocUpdate: (() => void) | null = null;

  if (!useP1) {
    const flushReaction = (): void => {
      if (reactionRunner === null) return;
      const run = reactionRunner;
      reactionRunner = null;
      run();
    };

    const scheduleReaction = (run: () => void): void => {
      reactionRunner = run;
      if (reactionMicrotaskQueued) {
        if (C.on) C.coalesceScheduled++;
        return;
      }
      reactionMicrotaskQueued = true;
      queueMicrotask(() => {
        reactionMicrotaskQueued = false;
        flushReaction();
      });
    };

    /**
     * Inbound signals (both share one coalesce path):
     * 1. MobX reaction on projection — preferred path, no Y dependency for tests
     * 2. doc.on("update") — drains pending reaction sync at end of applyUpdate
     *
     * Awareness is presence-only. Never pull content from selection publishes.
     */
    disposeReaction = reaction(
      () => {
        if (C.on) C.projectionKeyCalls++;
        lastProjection = computeProjection(text);
        return lastProjection.key;
      },
      () => {
        if (applying) {
          pending = true;
          return;
        }
        runPull();
      },
      {
        fireImmediately: false,
        scheduler: scheduleReaction,
      },
    );

    onDocUpdate = (): void => {
      if (applying) {
        pending = true;
        return;
      }
      if (reactionRunner !== null) {
        reactionMicrotaskQueued = false;
        flushReaction();
        return;
      }
      lastProjection = null;
      runPull();
    };
    opts.doc.on("update", onDocUpdate);
  }

  void plexus;

  const unregister = editor.registerUpdateListener(({ tags }) => {
    if (applying || tags.has(COLLAB_TAG)) return;
    applying = true;
    try {
      syncOutbound(editor, text);
      if (awareness) {
        const sel = readLocalSelection(editor);
        const prev = (awareness.getField("selection" as never) as SelectionPresence | null | undefined) ?? null;
        if (sel) {
          if (!prev || prev.anchor !== sel.anchor || prev.head !== sel.head) {
            awareness.setField("selection" as never, sel as never);
          }
        } else if (prev != null) {
          awareness.clearField("selection" as never);
        }
      }
    } finally {
      applying = false;
      if (pending) {
        pending = false;
        lastProjection = null;
        // P1: pending means events arrived mid-outbound; resync via P0 once.
        // P0: same runPull.
        runPull();
      }
    }
  });

  let onAwareness: (() => void) | undefined;
  if (awareness && onRemoteSelections) {
    onAwareness = () => {
      queueMicrotask(() => {
        onRemoteSelections(collectRemoteSelections(awareness, localId));
      });
    };
    awareness.on("change", onAwareness);
  }

  return () => {
    sliceGen++; // cancel N4 continuations
    disposeReaction?.();
    disposeP1?.();
    if (onDocUpdate) opts.doc.off("update", onDocUpdate);
    unregister();
    reactionRunner = null;
    reactionMicrotaskQueued = false;
    if (awareness && onAwareness) awareness.off("change", onAwareness);
    if (awareness) awareness.clearField("selection" as never);
  };
}

/** Run `fn` inside a liminal session; commit on success, revert on throw. */
export function withLiminalGesture(plexus: Plexus<PlexusText>, fn: () => void): void {
  plexus.enterLiminality();
  try {
    fn();
    plexus.commitLiminality();
  } catch (e) {
    plexus.revertLiminality();
    throw e;
  }
}

/** Snapshot remote selections (for tests / imperative UI). */
export function getRemoteSelections(awareness: PlexusAwareness, localClientId?: number): RemoteSelection[] {
  const localId = localClientId ?? awareness.doc.clientID;
  return collectRemoteSelections(awareness, localId);
}

// Re-export for callers that still want the single-hunk helper.
export { textDiff, textDiffs };
