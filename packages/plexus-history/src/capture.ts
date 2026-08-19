import type * as Y from "yjs";

import type { ClientIdToUserSession, Cut, DeleteRanges, UserSession } from "./types.js";

/** Capture-time metadata stamped into a cut (grounded — must be resolved while the session is live). */
export interface CutMeta {
  seq: number;
  timestamp: number;
  author: UserSession | null;
}

/**
 * Build a {@link Cut} from a finalized Yjs transaction. Pure: copies `tr.afterState`
 * and snapshots `tr.deleteSet` into a plain shape. Call at the `update` event (fires
 * only on change) or `afterTransaction` — by either point `afterState`/`deleteSet` are final.
 */
export function captureCut(tr: Y.Transaction, meta: CutMeta): Cut {
  const deletedRanges: DeleteRanges = new Map();
  tr.deleteSet.clients.forEach((items, client) => {
    deletedRanges.set(
      client,
      items.map((d) => ({ clock: d.clock, len: d.len })),
    );
  });
  return {
    seq: meta.seq,
    timestamp: meta.timestamp,
    author: meta.author,
    afterState: new Map(tr.afterState),
    deletedRanges,
  };
}

/** The acting (writing) client of a transaction — the one whose clock advanced. */
function actingClientId(tr: Y.Transaction): number | null {
  for (const [client, after] of tr.afterState) {
    if (after > (tr.beforeState.get(client) ?? 0)) return client;
  }
  // A pure-delete transaction advances no clock — there's no acting clientId in afterState.
  // bindCapture falls back to `originToUserSession` for attribution in that case.
  return null;
}

export interface BindCaptureOptions {
  /** Resolve a writer's clientID → who. Backed e.g. by PeerAttributionTracker. */
  clientIdToUserSession: ClientIdToUserSession;
  /**
   * Fallback when there's no acting clientID — a pure-delete txn advances no clock, so the
   * deleter isn't in `afterState` (and the deleteSet is keyed by the *deleted* item's client,
   * not the deleter's). Resolve from the transaction `origin` instead — e.g. the WebSocket →
   * principal. Without it, `detach`/`remove`/`clear` rows get `author: null` (the "who deleted
   * this" gap). Kept a hook — don't hardcode WS here.
   */
  originToUserSession?: (origin: unknown) => UserSession | null;
  /** Skip transactions whose origin doesn't pass (e.g. internal/shadow writes). */
  filter?: (origin: unknown) => boolean;
  /**
   * Receives each finished cut. **Async-aware and fire-and-forget**: bindCapture neither awaits
   * nor depends on it — the monotonic seq counter is owned in-memory and has already advanced.
   * A slow / failing persist therefore drops a cut (a tolerated gap in the {@link CutLog}); it
   * does NOT block, crash, or desync capture.
   */
  onCut: (cut: Cut) => void | Promise<void>;
  /**
   * Resume the seq counter on cold start. Pass `(cutLog.latest()?.seq ?? -1) + 1` after hydrating
   * the persisted log, so seq continues monotonically across restarts.
   */
  startSeq?: number;
}

/**
 * Server-side capture binding. Subscribes to the doc's `update` event, resolves the author
 * (acting clientID → `clientIdToUserSession`, falling back to `originToUserSession`), and emits a
 * finished {@link Cut} per changed transaction. Owns the monotonic seq counter (single-writer
 * leader ⇒ correct by construction). Returns an unsubscribe function.
 *
 * Capture belongs on the synced/main doc, server-side (NOT the shadow, NOT client-side).
 */
export function bindCapture(doc: Y.Doc, opts: BindCaptureOptions): () => void {
  let seq = opts.startSeq ?? 0;
  const handler = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
    if (opts.filter && !opts.filter(origin)) return;
    const client = actingClientId(tr);
    let author = client !== null ? opts.clientIdToUserSession(client) : null;
    if (author === null && opts.originToUserSession) author = opts.originToUserSession(origin);
    const cut = captureCut(tr, { seq: seq++, timestamp: Date.now(), author });
    // Fire-and-forget: a failed/slow async persist must not block or crash capture, and must
    // not desync seq (it already advanced). A lost cut is a gap the CutLog tolerates.
    void Promise.resolve(opts.onCut(cut)).catch(() => {});
  };
  doc.on("update", handler);
  return () => doc.off("update", handler);
}

// ── The `/capture` server barrel ──────────────────────────────────────────────
export { InMemoryCutLog, type CutLog, type CutRef, serializeCut, deserializeCut, type JsonCut } from "./cut-log.js";
export { applyRestore } from "./restore.js";
export type { Cut, UserSession, ClientIdToUserSession } from "./types.js";
