import type { Plexus, PlexusAwareness } from "@here.build/plexus";
import {
  addMark,
  colorForClientId,
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
  textEventsToReplaces,
  type TextEvent,
  type TextPresence,
  type TextReplace,
  toText,
  unformat,
} from "@here.build/plexus-text";
import { C } from "@here.build/plexus-text/bench";
import { reaction } from "mobx";
import {
  createEditor,
  Editor,
  Element,
  type Operation,
  type Point,
  Range,
  Text,
  Transforms,
  type Descendant,
} from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import * as Y from "yjs";

/**
 * Slate binding for PlexusText — collaborative single-paragraph rich text.
 *
 * Membrane law (docs/working-proposals/plexustext-editor-membrane.md):
 * - Outbound: editor delta → insertTextAt / deleteTextRange / addMark / unformat
 * - Inbound P0: model → textDiffs range replaces + format ranges (never full children=)
 * - Inbound P1: observePlexusText → O(d) TextReplace + markers-changed format path
 * - Observe P0: MobX on projection + doc.on("update") safety net (N1 coalesce)
 * - Observe P1: Y.Array events only — no dual MobX+doc content when P1 is live
 * - Awareness: presence only — never content pull
 * - Seed once on empty editor; thereafter only diffs
 * - No second collab identity tree — editor tree is a view
 *
 * N1: MobX reaction scheduler coalesces O(N) invalidations; doc update drains sync. (P0)
 * N2: pull reuses last tracking projection (toText + segments once per pull cycle). (P0)
 * N3 multi-hunk: textDiffs applied end→start (before-coords stay valid). (P0)
 * N4 time-slice: large hunk sets yield between batches; small pulls stay sync.
 * N5 format memo: when projection fmt fingerprint matches last applied, skip
 *   editor format walk (text-only remotes). (P0; P1 uses markers-changed for format)
 *
 * P1 (fork b): observePlexusText on nodes Y.Array; one event batch → one apply;
 *   resync / forced full agree uses P0 pull once.
 */

const FORMAT_TYPES = ["bold", "italic", "code"] as const;
type FormatType = (typeof FORMAT_TYPES)[number];

/** N4: yield between batches when total replace work or hunk count is large. */
const TIME_SLICE_CHARS = 8000;
const TIME_SLICE_HUNKS = 32;
const HUNK_CHUNK = 8;

export type SlateText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

export type SlateParagraph = {
  type: "paragraph";
  children: Array<SlateText>;
};

export type SlateDescendant = SlateParagraph;

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

// ── geometry: document offset ↔ Slate point (single paragraph) ─────────────────

function ensureParagraph(editor: Editor): void {
  if (editor.children.length === 0) {
    editor.children = [{ type: "paragraph", children: [{ text: "" }] } as Descendant];
  }
  const first = editor.children[0];
  if (!Element.isElement(first) || (first as SlateParagraph).type !== "paragraph") {
    editor.children = [{ type: "paragraph", children: [{ text: "" }] } as Descendant];
  }
  const para = editor.children[0] as SlateParagraph;
  if (!para.children || para.children.length === 0) {
    (para as { children: SlateText[] }).children = [{ text: "" }];
  }
}

function editorString(editor: Editor): string {
  ensureParagraph(editor);
  return Editor.string(editor, [0]);
}

function offsetToPoint(editor: Editor, offset: number): Point {
  ensureParagraph(editor);
  const para = editor.children[0] as SlateParagraph;
  let pos = 0;
  let last: Point = { path: [0, 0], offset: 0 };
  for (let i = 0; i < para.children.length; i++) {
    const leaf = para.children[i];
    const len = leaf.text.length;
    last = { path: [0, i], offset: len };
    if (pos + len >= offset) {
      return { path: [0, i], offset: Math.max(0, offset - pos) };
    }
    pos += len;
  }
  return last;
}

/** Apply a single TextReplace via range select + insertText — no full tree rebuild. */
function applyTextReplace(editor: Editor, diff: TextReplace): void {
  ensureParagraph(editor);
  const anchor = offsetToPoint(editor, diff.from);
  const focus = offsetToPoint(editor, diff.to);
  const range: Range = { anchor, focus };
  if (diff.from === diff.to && diff.insert.length === 0) return;
  Transforms.select(editor, range);
  if (diff.to > diff.from) {
    Transforms.delete(editor);
  }
  if (diff.insert.length > 0) {
    Transforms.insertText(editor, diff.insert);
  }
}

// ── format ranges ──────────────────────────────────────────────────────────────

type CharRange = { from: number; to: number };

function rangesWith(segs: Segment[], type: string): CharRange[] {
  const raw: CharRange[] = [];
  let offset = 0;
  for (const s of segs) {
    if (s.marks[type]) raw.push({ from: offset, to: offset + s.text.length });
    offset += s.text.length;
  }
  if (raw.length === 0) return raw;
  const merged: CharRange[] = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (last.to === raw[i].from) last.to = raw[i].to;
    else merged.push({ ...raw[i] });
  }
  return merged;
}

function subtractRanges(a: CharRange[], b: CharRange[]): CharRange[] {
  if (a.length === 0) return [];
  if (b.length === 0) return a.map((r) => ({ ...r }));
  const out: CharRange[] = [];
  for (const ar of a) {
    let pieces: CharRange[] = [{ from: ar.from, to: ar.to }];
    for (const br of b) {
      const next: CharRange[] = [];
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

function leafMarks(leaf: SlateText): Marks {
  const marks: Marks = {};
  for (const type of FORMAT_TYPES) {
    if (leaf[type]) marks[type] = true;
  }
  return marks;
}

function editorSegments(editor: Editor): Segment[] {
  ensureParagraph(editor);
  const para = editor.children[0] as SlateParagraph;
  const out: Segment[] = [];
  for (const leaf of para.children) {
    if (leaf.text.length === 0) continue;
    const marks = leafMarks(leaf);
    const prev = out[out.length - 1];
    if (prev !== undefined && sameMarks(prev.marks, marks)) prev.text += leaf.text;
    else out.push({ text: leaf.text, marks });
  }
  return out;
}

function applyFormatRange(editor: Editor, from: number, to: number, type: FormatType, on: boolean): void {
  if (to <= from) return;
  const anchor = offsetToPoint(editor, from);
  const focus = offsetToPoint(editor, to);
  const at: Range = { anchor, focus };
  if (on) {
    Transforms.setNodes(editor, { [type]: true } as Partial<SlateText>, {
      at,
      match: Text.isText,
      split: true,
    });
  } else {
    Transforms.unsetNodes(editor, type, {
      at,
      match: Text.isText,
      split: true,
    });
  }
}

function applyFormatDiff(editor: Editor, modelSegs: Segment[]): boolean {
  const edSegs = editorSegments(editor);
  let changed = false;
  const priorSel = editor.selection ? { ...editor.selection } : null;

  for (const type of FORMAT_TYPES) {
    const want = rangesWith(modelSegs, type);
    const have = rangesWith(edSegs, type);
    for (const r of subtractRanges(want, have)) {
      applyFormatRange(editor, r.from, r.to, type, true);
      changed = true;
    }
    for (const r of subtractRanges(have, want)) {
      applyFormatRange(editor, r.from, r.to, type, false);
      changed = true;
    }
  }

  if (priorSel) {
    try {
      Transforms.select(editor, priorSel);
    } catch {
      /* selection path may have been split — leave Slate default */
    }
  }
  return changed;
}

// ── inbound: model → editor (minimal) ──────────────────────────────────────────

/**
 * Project model → editor with the smallest possible Slate ops.
 * - Text: multi-hunk TextReplace via select+delete+insertText (end→start)
 * - Format: only the range deltas that differ (skipped when N5 fmt fingerprint matches)
 * Forbidden: editor.children = [...] on the live path.
 *
 * When `projected` is provided (N2), skips re-calling toText/segments.
 * When `skipFormat` (N5), skips editor format walk entirely.
 */
function pullMinimalSync(
  editor: Editor,
  text: PlexusText,
  projected: Projection | undefined,
  skipFormat: boolean,
  orderedHunks: TextReplace[],
): boolean {
  let changed = false;
  const run = (): void => {
    for (const h of orderedHunks) {
      applyTextReplace(editor, h);
      changed = true;
    }

    if (!skipFormat) {
      const modelSegs = projected?.segs ?? segments(text);
      if (applyFormatDiff(editor, modelSegs)) changed = true;
    }
  };

  // Avoid recording remote ops in local undo history when available.
  if (isHistoryEditor(editor)) {
    HistoryEditor.withoutSaving(editor, run);
  } else {
    run();
  }
  return changed;
}

function isHistoryEditor(editor: Editor): editor is HistoryEditor & Editor {
  return typeof (editor as HistoryEditor).history === "object" && (editor as HistoryEditor).history !== null;
}

/** Initial load only — empty editor, full content once. Still segment-based, one pass. */
function seedEditor(editor: Editor, text: PlexusText): void {
  const segs = segments(text);
  const children: SlateText[] =
    segs.length === 0
      ? [{ text: "" }]
      : segs.map((seg) => {
          const leaf: SlateText = { text: seg.text };
          for (const type of FORMAT_TYPES) {
            if (seg.marks[type]) leaf[type] = true;
          }
          return leaf;
        });
  // Seed is the only full structure write — empty editor path only.
  editor.children = [{ type: "paragraph", children } as Descendant];
  if (!editor.selection) {
    const end = Editor.end(editor, [0]);
    Transforms.select(editor, end);
  }
}

// ── outbound ────────────────────────────────────────────────────────────────────

function syncText(editor: Editor, text: PlexusText): void {
  const editorText = editorString(editor);
  const hunks = textDiffs(toText(text), editorText);
  // Before-coords → apply high→low so later (lower) hunks stay valid.
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i];
    if (h.to > h.from) deleteTextRange(text, h.from, h.to);
    if (h.insert.length > 0) insertTextAt(text, h.from, h.insert);
  }
}

function syncFormats(editor: Editor, text: PlexusText): void {
  const edSegs = editorSegments(editor);
  const modelSegs = segments(text);
  for (const type of FORMAT_TYPES) {
    const want = rangesWith(edSegs, type);
    const have = rangesWith(modelSegs, type);
    for (const r of subtractRanges(want, have)) addMark(text, r.from, r.to, type, true);
    for (const r of subtractRanges(have, want)) unformat(text, r.from, r.to, type);
  }
}

function syncOutbound(editor: Editor, text: PlexusText): void {
  syncText(editor, text);
  syncFormats(editor, text);
}

function readLocalSelection(editor: Editor): SelectionPresence | null {
  const sel = editor.selection;
  if (!sel) return null;
  try {
    const anchor = Editor.string(editor, {
      anchor: Editor.start(editor, [0]),
      focus: sel.anchor,
    }).length;
    const head = Editor.string(editor, {
      anchor: Editor.start(editor, [0]),
      focus: sel.focus,
    }).length;
    return { anchor, head };
  } catch {
    return null;
  }
}

/** Remote selection snapshot for UI / tests. */
export type RemoteSelection = {
  peerId: number;
  selection: SelectionPresence;
  user?: EditorUser;
  color: string;
};

/** Projector mode — P1 uses structured Y.Array events; P0 is textDiff fallback. */
export type ProjectorMode = "auto" | "p0" | "p1";

export type BindSlateOptions = {
  doc: Y.Doc;
  plexus?: Plexus<PlexusText>;
  awareness?: PlexusAwareness;
  user?: EditorUser;
  /** Called whenever remote selections change (paint carets in your React / Plate layer). */
  onRemoteSelections?: (remotes: RemoteSelection[]) => void;
  /**
   * Inbound projector. Default `"auto"`: P1 if `observePlexusText` succeeds, else P0.
   * Tests may pin `"p0"` | `"p1"`.
   */
  projector?: ProjectorMode;
  /** Fired when P1 geometry desyncs and the binding falls back to one P0 pull. */
  onResync?: (reason: string) => void;
};

function resolveOpts(docOrOpts: Y.Doc | BindSlateOptions): BindSlateOptions {
  if (docOrOpts && typeof docOrOpts === "object" && "doc" in docOrOpts && (docOrOpts as BindSlateOptions).doc) {
    return docOrOpts as BindSlateOptions;
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

/**
 * Two-way-bind a Slate editor to a PlexusText. Returns an unbind function.
 * Plate editors are Slate Editors — use bindPlate (thin alias) from plexus-text-plate.
 */
export function bindSlate(
  editor: Editor,
  text: PlexusText,
  docOrOpts: Y.Doc | BindSlateOptions,
): () => void {
  const opts = resolveOpts(docOrOpts);
  const { user, onRemoteSelections } = opts;
  const plexus = opts.plexus;
  const awareness = opts.awareness ?? plexus?.awareness;
  const localId = awareness?.doc.clientID ?? opts.doc.clientID;
  const projectorPref: ProjectorMode = opts.projector ?? "auto";
  const onResync = opts.onResync;
  const doc = opts.doc;

  let applying = false;
  let pending = false;
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

  const finishPull = (appliedFmt: string | null): void => {
    if (appliedFmt !== null) lastAppliedFmt = appliedFmt;
    applying = false;
    if (pending) {
      pending = false;
      lastProjection = null;
      runPull();
    }
  };

  /** P0 full pull: toText + textDiffs + format. Used for resync and pure P0 mode. */
  const runPull = (): void => {
    if (applying) {
      pending = true;
      return;
    }
    if (C.on) C.pulls++;
    applying = true;

    const projected = lastProjection ?? computeProjection(text);
    const editorText = editorString(editor);
    const hunks = textDiffs(editorText, projected.body);
    const ordered = hunksDescending(hunks);
    // N5: skip editor format walk when mark fingerprint unchanged since last apply.
    const skipFormat = lastAppliedFmt !== null && projected.fmt === lastAppliedFmt;
    const nextFmt = skipFormat ? null : projected.fmt;

    if (ordered.length === 0 && skipFormat) {
      finishPull(null);
      return;
    }

    if (!shouldTimeSlice(ordered)) {
      pullMinimalSync(editor, text, projected, skipFormat, ordered);
      finishPull(nextFmt);
      return;
    }

    // N4 large path: text hunks in descending chunks; format once at end.
    const gen = sliceGen;
    let idx = 0;
    const step = (): void => {
      if (gen !== sliceGen) return;
      const end = Math.min(idx + HUNK_CHUNK, ordered.length);
      const batch = ordered.slice(idx, end);
      const isLast = end >= ordered.length;
      const run = (): void => {
        for (const h of batch) applyTextReplace(editor, h);
        if (isLast && !skipFormat) {
          applyFormatDiff(editor, projected.segs);
        }
      };
      if (isHistoryEditor(editor)) {
        HistoryEditor.withoutSaving(editor, run);
      } else {
        run();
      }
      idx = end;
      if (!isLast) {
        queueMicrotask(step);
      } else {
        finishPull(nextFmt);
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
    if (replaces.length === 0 && !markersChanged) return;

    if (C.on) C.pulls++;
    applying = true;

    let nextFmt: string | null = null;
    const runFormat = (): void => {
      if (!markersChanged) return;
      const segs = segments(text);
      applyFormatDiff(editor, segs);
      nextFmt = fmtFingerprint(segs);
    };

    if (!shouldTimeSlice(replaces)) {
      try {
        const run = (): void => {
          // Sequential model coords → sequential Slate ops (not same-doc reverse).
          for (const h of replaces) applyTextReplace(editor, h);
          runFormat();
        };
        if (isHistoryEditor(editor)) {
          HistoryEditor.withoutSaving(editor, run);
        } else {
          run();
        }
      } finally {
        finishPull(nextFmt);
      }
      return;
    }

    // N4: still sequential (coords depend on prior); yield between chunks; format at end.
    const gen = sliceGen;
    let idx = 0;
    const step = (): void => {
      if (gen !== sliceGen) return;
      const end = Math.min(idx + HUNK_CHUNK, replaces.length);
      const batch = replaces.slice(idx, end);
      const isLast = end >= replaces.length;
      const run = (): void => {
        for (const h of batch) applyTextReplace(editor, h);
        if (isLast) runFormat();
      };
      if (isHistoryEditor(editor)) {
        HistoryEditor.withoutSaving(editor, run);
      } else {
        run();
      }
      idx = end;
      if (!isLast) {
        queueMicrotask(step);
      } else {
        finishPull(nextFmt);
      }
    };
    step();
  };

  let disposeP1: (() => void) | null = null;
  let useP1 = false;

  if (projectorPref !== "p0") {
    disposeP1 = observePlexusText(text, applyP1Events, { doc });
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
     * 1. MobX reaction on projection — preferred path
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
    doc.on("update", onDocUpdate);
  }

  // Slate's default onChange is deferred to a microtask (FLUSHING). Collab needs
  // synchronous outbound after content ops so peers/tests don't race the flush.
  const rawApply = editor.apply.bind(editor);
  editor.apply = (op: Operation) => {
    rawApply(op);
    if (applying) return;
    if (op.type === "set_selection") {
      // Presence only — never content pull.
      if (awareness) {
        const sel = readLocalSelection(editor);
        const prev =
          (awareness.getField("selection" as never) as SelectionPresence | null | undefined) ?? null;
        if (sel) {
          if (!prev || prev.anchor !== sel.anchor || prev.head !== sel.head) {
            awareness.setField("selection" as never, sel as never);
          }
        } else if (prev != null) {
          awareness.clearField("selection" as never);
        }
      }
      return;
    }
    applying = true;
    try {
      syncOutbound(editor, text);
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
  };

  let onAwareness: (() => void) | undefined;
  if (awareness && onRemoteSelections) {
    onAwareness = () => {
      queueMicrotask(() => {
        onRemoteSelections(collectRemoteSelections(awareness, localId));
      });
    };
    awareness.on("change", onAwareness);
  }

  void plexus;

  return () => {
    sliceGen++; // cancel N4 continuations
    disposeReaction?.();
    disposeP1?.();
    if (onDocUpdate) doc.off("update", onDocUpdate);
    editor.apply = rawApply;
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

/**
 * Create a Slate editor suitable for collab (history-enabled).
 * Plate consumers can pass this into Plate or use their own createPlateEditor —
 * any editor that is a Slate `Editor` works with `bindSlate`.
 */
export function createSlateBoundEditor(): Editor {
  return withHistory(createEditor());
}

// Re-export types useful to plate / hosts
export type { Editor, Operation };
export { textDiff, textDiffs };
