import { Annotation, type Extension } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate, EditorView } from "@codemirror/view";
import type { Plexus, PlexusAwareness } from "@here.build/plexus";
import {
  deleteTextRange,
  type EditorUser,
  insertTextAt,
  observePlexusText,
  type PlexusText,
  textDiff,
  textDiffs,
  textEventsToReplaces,
  type TextEvent,
  type TextReplace,
  toText,
} from "@here.build/plexus-text";
import { C } from "@here.build/plexus-text/bench";
import { reaction } from "mobx";
import * as Y from "yjs";

import { plexusTextAwareness } from "./awareness.js";

/**
 * CodeMirror 6 binding for PlexusText — collaborative plain-text path.
 *
 * Membrane principle (anti-Yjs-full-rebuild):
 * - Outbound: CM change set → insertTextAt / deleteTextRange (already minimal)
 * - Inbound P0: toText → textDiffs → multi-hunk CM changes (never replace the whole doc)
 * - Inbound P1: Y.Array observe → TextEvent → O(d) CM ops (no toText on live path)
 *
 * N1 coalesce: MobX reaction scheduler batches O(N) invalidations to one re-run;
 *   doc.on("update") drains the pending reaction synchronously at end of Y apply
 *   so tests stay sync and pulls === 1 per remote batch. (P0 path only.)
 * N2 one projection: pull reuses the string from the last tracking run when present.
 * N3 multi-hunk: textDiffs → all replaces in one dispatch (original coords) or
 *   descending batches when time-sliced.
 * N4 time-slice: large applies (>TIME_SLICE_CHARS work or >TIME_SLICE_HUNKS) yield
 *   between batches via queueMicrotask; small pulls stay fully synchronous.
 *
 * P1 (fork b): observePlexusText on nodes Y.Array; one event batch → one apply;
 *   resync / forced full agree uses P0 pull once.
 */

/** Tags our own remote-applied transactions so the outbound listener ignores them. */
const fromPlexus = Annotation.define<boolean>();

/** N4: yield between batches when total replace work or hunk count is large. */
const TIME_SLICE_CHARS = 8000;
const TIME_SLICE_HUNKS = 32;
const HUNK_CHUNK = 8;

export { textDiff, textDiffs };
export { plexusTextAwareness, remoteSelectionsTheme } from "./awareness.js";
export type { AwarenessExtensionOpts } from "./awareness.js";

/** Apply a CM edit — delete [from, to), then insert at `from` — onto the content. */
export function applyCmChange(text: PlexusText, from: number, to: number, insert: string): void {
  if (to > from) deleteTextRange(text, from, to);
  if (insert.length > 0) insertTextAt(text, from, insert);
}

function totalHunkWork(hunks: TextReplace[]): number {
  let w = 0;
  for (const h of hunks) w += h.to - h.from + h.insert.length;
  return w;
}

function shouldTimeSlice(hunks: TextReplace[]): boolean {
  return hunks.length > TIME_SLICE_HUNKS || totalHunkWork(hunks) > TIME_SLICE_CHARS;
}

/** Descending `from` so sequential multi-dispatch keeps before-coords valid. */
function hunksDescending(hunks: TextReplace[]): TextReplace[] {
  return hunks.length <= 1 ? hunks : [...hunks].sort((a, b) => b.from - a.from || b.to - a.to);
}

/** Projector mode — P1 uses structured Y.Array events; P0 is textDiff fallback. */
export type ProjectorMode = "auto" | "p0" | "p1";

export type PlexusTextSyncOptions = {
  doc: Y.Doc;
  /**
   * Plexus instance owning this doc. Preferred: enables liminal peer re-render
   * and uses `plexus.awareness` when `awareness` is omitted.
   */
  plexus?: Plexus<PlexusText>;
  /** Awareness channel (defaults to `plexus.awareness` when plexus is set). */
  awareness?: PlexusAwareness;
  /** Local user identity for remote caret labels. */
  user?: EditorUser;
  /**
   * Inbound projector. Default `"auto"`: P1 if `observePlexusText` succeeds, else P0.
   * Tests may pin `"p0"` | `"p1"`.
   */
  projector?: ProjectorMode;
  /** Fired when P1 geometry desyncs and the binding falls back to one P0 pull. */
  onResync?: (reason: string) => void;
};

function resolveOpts(docOrOpts: Y.Doc | PlexusTextSyncOptions): PlexusTextSyncOptions {
  if (docOrOpts && typeof docOrOpts === "object" && "doc" in docOrOpts && (docOrOpts as PlexusTextSyncOptions).doc) {
    return docOrOpts as PlexusTextSyncOptions;
  }
  return { doc: docOrOpts as Y.Doc };
}

/**
 * Two-way-bind the view's plain text to a PlexusText.
 * Pass a bare `Y.Doc` (legacy) or full options for awareness + liminality + projector.
 */
export function plexusTextSync(text: PlexusText, docOrOpts: Y.Doc | PlexusTextSyncOptions): Extension {
  const opts = resolveOpts(docOrOpts);
  const { doc, user } = opts;
  const plexus = opts.plexus;
  const awareness = opts.awareness ?? plexus?.awareness;
  const projectorPref: ProjectorMode = opts.projector ?? "auto";
  const onResync = opts.onResync;

  const syncPlugin = ViewPlugin.define((view) => {
    let applying = false;
    let pending = false;
    /** Last model text produced by the MobX tracking function (N2 reuse, P0). */
    let lastTrackedText: string | null = null;
    /** Pending MobX reaction runner (coalesced by custom scheduler, P0). */
    let reactionRunner: (() => void) | null = null;
    let reactionMicrotaskQueued = false;
    /** Bumps on destroy / superseding pull to cancel in-flight N4 slices. */
    let sliceGen = 0;

    const finishPull = (): void => {
      applying = false;
      if (pending) {
        pending = false;
        lastTrackedText = null;
        runPull();
      }
    };

    const dispatchHunksSameDoc = (hunks: TextReplace[]): void => {
      view.dispatch({
        changes: hunks.map((h) => ({ from: h.from, to: h.to, insert: h.insert })),
        annotations: fromPlexus.of(true),
      });
    };

    /** Sequential coords (P1 event stream) — each op sees the doc after prior ops. */
    const dispatchReplacesSequential = (hunks: TextReplace[]): void => {
      for (const h of hunks) {
        view.dispatch({
          changes: { from: h.from, to: h.to, insert: h.insert },
          annotations: fromPlexus.of(true),
        });
      }
    };

    /**
     * Apply multi-hunk inbound (P0 same-doc coords). Small: one CM dispatch.
     * Large (N4): descending batches with queueMicrotask; `applying` stays true.
     */
    const applyInboundHunksP0 = (hunks: TextReplace[]): void => {
      if (hunks.length === 0) {
        finishPull();
        return;
      }
      if (!shouldTimeSlice(hunks)) {
        dispatchHunksSameDoc(hunks);
        finishPull();
        return;
      }
      const ordered = hunksDescending(hunks);
      const gen = sliceGen;
      let idx = 0;
      const step = (): void => {
        if (gen !== sliceGen) return;
        const end = Math.min(idx + HUNK_CHUNK, ordered.length);
        dispatchHunksSameDoc(ordered.slice(idx, end));
        idx = end;
        if (idx < ordered.length) {
          queueMicrotask(step);
        } else {
          finishPull();
        }
      };
      step();
    };

    /** P0 full pull: toText + textDiffs. Used for seed, resync, and pure P0 mode. */
    const runPull = (): void => {
      if (applying) {
        pending = true;
        return;
      }
      if (C.on) C.pulls++;
      applying = true;
      const modelText = lastTrackedText ?? toText(text);
      const hunks = textDiffs(view.state.doc.toString(), modelText);
      applyInboundHunksP0(hunks);
    };

    // ── P1 structured events ───────────────────────────────────────────────────
    const applyP1Events = (events: TextEvent[]): void => {
      // Self-echo: local outbound holds `applying` through the Y afterTransaction
      // that delivers these events — editor already has the text; drop without
      // scheduling a P0 pull (that would reintroduce toText on every keystroke).
      // True remote-during-apply is rare on this path; pending is still used by
      // finishPull if a later signal needs a full agree.
      if (applying) return;
      const { replaces, resync, resyncReason } = textEventsToReplaces(events);
      if (resync) {
        onResync?.(resyncReason ?? "p1-resync");
        lastTrackedText = null;
        runPull();
        return;
      }
      if (replaces.length === 0) {
        // markers-changed only — plain CM has no format surface
        return;
      }
      if (C.on) C.pulls++;
      applying = true;
      // Sequential model coords → sequential CM dispatches (not same-doc array).
      if (!shouldTimeSlice(replaces)) {
        try {
          dispatchReplacesSequential(replaces);
        } finally {
          finishPull();
        }
        return;
      }
      // N4: still sequential (coords depend on prior); yield between chunks.
      const gen = sliceGen;
      let idx = 0;
      const step = (): void => {
        if (gen !== sliceGen) return;
        const end = Math.min(idx + HUNK_CHUNK, replaces.length);
        dispatchReplacesSequential(replaces.slice(idx, end));
        idx = end;
        if (idx < replaces.length) {
          queueMicrotask(step);
        } else {
          finishPull();
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

    // Seed once (both modes) — allowed toText on bind.
    runPull();

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

      disposeReaction = reaction(
        () => {
          if (C.on) C.projectionKeyCalls++;
          lastTrackedText = toText(text);
          return lastTrackedText;
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
        lastTrackedText = null;
        runPull();
      };
      doc.on("update", onDocUpdate);
    }

    void plexus;

    return {
      update(u: ViewUpdate) {
        if (applying || !u.docChanged) return;
        if (u.transactions.some((t) => t.annotation(fromPlexus) === true)) return;
        const edits: { from: number; to: number; insert: string }[] = [];
        u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
          edits.push({ from: fromA, to: toA, insert: inserted.toString() }),
        );
        applying = true;
        try {
          // CM already delivers multi-change sets; apply high→low so model offsets hold.
          for (let i = edits.length - 1; i >= 0; i--) {
            applyCmChange(text, edits[i]!.from, edits[i]!.to, edits[i]!.insert);
          }
        } finally {
          applying = false;
          if (pending) {
            pending = false;
            lastTrackedText = null;
            // P1: pending means events arrived mid-outbound; resync via P0 once.
            // P0: same runPull.
            runPull();
          }
        }
      },
      destroy() {
        sliceGen++;
        disposeReaction?.();
        disposeP1?.();
        if (onDocUpdate) doc.off("update", onDocUpdate);
        reactionRunner = null;
        reactionMicrotaskQueued = false;
      },
    };
  });

  const extensions: Extension[] = [syncPlugin];
  if (awareness) {
    extensions.push(plexusTextAwareness({ awareness, user }));
  }
  return extensions;
}

/**
 * Convenience: run `fn` inside a liminal session, commit on success, revert on throw.
 * Text edits made through the binding (or model) while liminal stay ephemeral until commit.
 */
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

// re-export EditorView for consumers who theme remote carets
export type { EditorView };
