/**
 * P1 structured event stream — G1 settled on **Y.Array observe** (yjs-native deltas).
 *
 * MobX is NOT the P1 delta source (ACCESS_ALL is Θ(N) firings). We observe the
 * Y.Array that backs `PlexusText.nodes` (`@syncing.child.list` → Y.Array of entity
 * refs) and emit O(d) `TextEvent`s with char geometry maintained in a shadow that
 * never stores editor keys. Riding Y.Array is intentional yjs compatibility —
 * prefer richer in-yjs observe payloads if/when available; do not invent a second
 * collab tree or core splice PR just for this.
 *
 * After each delivered batch we dirty the N6 `listIndexAtOffset` cache so local
 * geometry does not lag remote materialization.
 *
 * Law: docs/working-proposals/plexustext-lexical-crdt-binding.md §3.2–3.3
 *      docs/working-proposals/plexustext-non-freezing-algos.md B3
 *      eng-review G1 → Y.Array (explicit, not interim)
 */

import type * as Y from "yjs";

import { C } from "./bench/counters.js";
import {
  invalidateListGeometry,
  isMarker,
  isTextAtom,
  type PlexusText,
  type SeqNode,
  type TextAtom,
} from "./PlexusText.js";

// ── public vocabulary ──────────────────────────────────────────────────────────

export type TextEvent =
  | { type: "atoms-inserted"; offset: number; text: string }
  | { type: "atoms-removed"; from: number; to: number }
  | { type: "atom-text-replaced"; from: number; to: number; text: string }
  | { type: "markers-changed" }
  | { type: "resync"; reason: string };

export type TextEventsHandler = (events: TextEvent[]) => void;

export type ObservePlexusTextOptions = {
  /**
   * Optional Y.Doc (or anything with afterTransaction hooks). Defaults to
   * `text.__doc__`. Consumers need not import yjs when the text is doc-connected.
   */
  doc?: Y.Doc | null;
};

// ── geometry shadow (id / kind / len only — never editor keys) ─────────────────

type GeoKind = "atom" | "marker";

type GeoEntry = {
  /** Plexus entity uuid — CRDT identity, not an editor key. */
  id: string;
  kind: GeoKind;
  /** UTF-16 code units; 0 for markers. */
  len: number;
};

type Shadow = {
  entries: GeoEntry[];
  /** prefix[i] = char offset before entries[i]; length n+1. */
  prefix: number[];
};

function emptyShadow(): Shadow {
  return { entries: [], prefix: [0] };
}

function rebuildShadowFromNodes(text: PlexusText): Shadow {
  const entries: GeoEntry[] = [];
  const prefix: number[] = [0];
  let run = 0;
  for (const n of text.nodes) {
    const e = entryFromNode(n);
    if (!e) continue; // should not happen; caller will resync if lengths drift
    entries.push(e);
    run += e.len;
    prefix.push(run);
  }
  return { entries, prefix };
}

function entryFromNode(n: SeqNode): GeoEntry | null {
  try {
    if (isTextAtom(n)) {
      return { id: n.uuid, kind: "atom", len: n.text.length };
    }
    if (isMarker(n)) {
      return { id: n.uuid, kind: "marker", len: 0 };
    }
  } catch {
    return null;
  }
  return null;
}

function prefixRebuildTail(shadow: Shadow, fromIndex: number): void {
  const { entries, prefix } = shadow;
  let run = prefix[fromIndex] ?? 0;
  for (let i = fromIndex; i < entries.length; i++) {
    run += entries[i]!.len;
    prefix[i + 1] = run;
  }
  prefix.length = entries.length + 1;
}

function charOffsetAt(shadow: Shadow, listIndex: number): number {
  if (listIndex <= 0) return 0;
  if (listIndex >= shadow.entries.length) return shadow.prefix[shadow.entries.length] ?? 0;
  return shadow.prefix[listIndex] ?? 0;
}

// ── resolve Y.Array for text.nodes ─────────────────────────────────────────────

/**
 * How we find the array:
 * `PlexusModel.__yjsFieldsMap__` is the entity's `PlexusWrapper` over its
 * `Y.XmlElement`. `@syncing.child.list` fields materialize as `Y.Array` attributes
 * (see `proxies/array.ts` → `owner.__yjsFieldsMap__?.get(key)` and
 * `materializeArrayForField`). Touching `text.nodes` forces genesis if needed.
 */
export function getNodesYArray(text: PlexusText): Y.Array<unknown> | null {
  // Ensure the list proxy has run ensureYjsArray (first write / materialize path).
  void text.nodes.length;
  const wrapper = text.__yjsFieldsMap__;
  if (!wrapper) return null;
  const arr = wrapper.get("nodes");
  if (arr && typeof (arr as Y.Array<unknown>).observe === "function") {
    return arr as Y.Array<unknown>;
  }
  return null;
}

// ── atom text watchers (trim / LWW string replace — not list deltas) ───────────

type AtomWatch = {
  unobserve: () => void;
};

function attachAtomTextWatch(
  atom: TextAtom,
  onText: (atom: TextAtom, newText: string) => void,
): AtomWatch | null {
  const wrapper = atom.__yjsFieldsMap__;
  const element = wrapper?.element as Y.XmlElement | undefined;
  if (!element || typeof element.observe !== "function") return null;

  const handler = (event: Y.YXmlEvent): void => {
    if (!event.attributesChanged.has("text")) return;
    onText(atom, atom.text);
  };
  element.observe(handler);
  return {
    unobserve: () => {
      element.unobserve(handler);
    },
  };
}

// ── observePlexusText ──────────────────────────────────────────────────────────

/**
 * Subscribe to O(d) structured content events for a doc-connected PlexusText.
 *
 * @returns dispose function, or `null` if no Y.Array is available (doc-less /
 *          not materialized) — bindings should stay on P0.
 *
 * One Y transaction → one handler call with an ordered `TextEvent[]`.
 * Geometry desync → single `{ type: "resync", reason }` (binding falls back to P0 once).
 */
export function observePlexusText(
  text: PlexusText,
  onEvents: TextEventsHandler,
  opts?: ObservePlexusTextOptions,
): (() => void) | null {
  const arr = getNodesYArray(text);
  if (!arr) return null;

  const doc = opts?.doc ?? (text.__doc__ as Y.Doc | null) ?? arr.doc;
  if (!doc) return null;

  // Touch nodes so Plexus's array observer is registered *before* ours — then
  // materialize happens first and text.nodes is current when we map inserts.
  void text.nodes.length;

  let shadow = rebuildShadowFromNodes(text);
  const atomWatches = new Map<string, AtomWatch>();
  let disposed = false;
  /**
   * In-flight batch for the current Y transaction. Array + atom-text observes
   * queue here; we flush synchronously at the end of each observe callback and
   * again on afterTransaction so multi-source txns collapse to one delivery when
   * possible, without waiting a microtask (tests and CM assert sync after applyUpdate).
   */
  let pending: TextEvent[] | null = null;

  const coalesce = (events: TextEvent[]): TextEvent[] => {
    const out: TextEvent[] = [];
    let markersSeen = false;
    for (const e of events) {
      if (e.type === "markers-changed") {
        if (markersSeen) continue;
        markersSeen = true;
        out.push(e);
        continue;
      }
      if (e.type === "resync") {
        return [e];
      }
      markersSeen = false;
      out.push(e);
    }
    return out;
  };

  const deliver = (events: TextEvent[]): void => {
    if (disposed || events.length === 0) return;
    const out = coalesce(events);
    if (out.length === 0) return;
    // Remote path bypasses local intent ops — keep N6 list geometry honest.
    invalidateListGeometry(text);
    if (C.on) {
      C.p1Events += out.length;
      for (const e of out) {
        if (e.type === "resync") C.p1Resyncs++;
      }
    }
    onEvents(out);
  };

  const flushPending = (): void => {
    if (!pending || pending.length === 0) {
      pending = null;
      return;
    }
    const evs = pending;
    pending = null;
    deliver(evs);
  };

  const queue = (events: TextEvent[]): void => {
    if (disposed || events.length === 0) return;
    if (!pending) pending = [];
    pending.push(...events);
  };

  const onAfterTransaction = (): void => {
    flushPending();
  };
  doc.on("afterTransaction", onAfterTransaction);

  const resync = (reason: string): void => {
    // Drop atom watches and rebuild shadow from ground truth.
    for (const w of atomWatches.values()) w.unobserve();
    atomWatches.clear();
    shadow = rebuildShadowFromNodes(text);
    for (const n of text.nodes) {
      if (isTextAtom(n)) watchAtom(n);
    }
    queue([{ type: "resync", reason }]);
  };

  const watchAtom = (atom: TextAtom): void => {
    const id = atom.uuid;
    if (atomWatches.has(id)) return;
    const w = attachAtomTextWatch(atom, (a, newText) => {
      if (disposed) return;
      const idx = shadow.entries.findIndex((e) => e.id === a.uuid);
      if (idx < 0) {
        resync("atom-text-unknown-id");
        return;
      }
      const entry = shadow.entries[idx]!;
      const oldLen = entry.len;
      const from = charOffsetAt(shadow, idx);
      entry.len = newText.length;
      prefixRebuildTail(shadow, idx);
      queue([{ type: "atom-text-replaced", from, to: from + oldLen, text: newText }]);
      flushPending();
    });
    if (w) atomWatches.set(id, w);
  };

  // Seed watches for current atoms.
  for (const n of text.nodes) {
    if (isTextAtom(n)) watchAtom(n);
  }

  const onArrayEvent = (event: Y.YArrayEvent<unknown>): void => {
    if (disposed) return;
    if (event.target !== arr) return;

    const delta = event.changes.delta;
    if (!delta || delta.length === 0) return;

    const events: TextEvent[] = [];
    let listIndex = 0;

    try {
      for (const d of delta) {
        if (d.retain != null) {
          listIndex += d.retain;
          continue;
        }

        if (d.delete != null) {
          const del = d.delete;
          if (listIndex + del > shadow.entries.length) {
            resync("delete-past-shadow");
            return;
          }
          const from = charOffsetAt(shadow, listIndex);
          let removedChars = 0;
          let anyMarker = false;
          let anyAtom = false;
          for (let k = 0; k < del; k++) {
            const e = shadow.entries[listIndex + k]!;
            if (e.kind === "atom") {
              anyAtom = true;
              removedChars += e.len;
              const w = atomWatches.get(e.id);
              if (w) {
                w.unobserve();
                atomWatches.delete(e.id);
              }
            } else {
              anyMarker = true;
            }
          }
          shadow.entries.splice(listIndex, del);
          prefixRebuildTail(shadow, listIndex);
          if (anyAtom && removedChars > 0) {
            events.push({ type: "atoms-removed", from, to: from + removedChars });
          }
          if (anyMarker) {
            events.push({ type: "markers-changed" });
          }
          // listIndex stays — subsequent items slid down
          continue;
        }

        if (d.insert != null) {
          const insertCount = d.insert.length;
          // After Plexus materialize (its observer registered first), nodes[listIndex..]
          // holds the new entities.
          const nodes = text.nodes;
          if (listIndex + insertCount > nodes.length) {
            resync("insert-nodes-short");
            return;
          }

          const insertAtChar = charOffsetAt(shadow, listIndex);
          const newEntries: GeoEntry[] = [];
          let atomRun = "";
          let atomRunOffset = insertAtChar;
          let markersInInsert = false;
          let charsInserted = 0;

          const flushAtomRun = (): void => {
            if (atomRun.length === 0) return;
            events.push({ type: "atoms-inserted", offset: atomRunOffset, text: atomRun });
            atomRun = "";
          };

          for (let j = 0; j < insertCount; j++) {
            const node = nodes[listIndex + j];
            if (!node) {
              resync("insert-node-missing");
              return;
            }
            const e = entryFromNode(node);
            if (!e) {
              resync("insert-node-untyped");
              return;
            }
            newEntries.push(e);
            if (e.kind === "atom") {
              if (atomRun.length === 0) atomRunOffset = insertAtChar + charsInserted;
              atomRun += (node as TextAtom).text;
              charsInserted += e.len;
              watchAtom(node as TextAtom);
            } else {
              flushAtomRun();
              markersInInsert = true;
            }
          }
          flushAtomRun();
          if (markersInInsert) {
            events.push({ type: "markers-changed" });
          }

          shadow.entries.splice(listIndex, 0, ...newEntries);
          // Rebuild prefix from insert site: extend prefix slots then recompute tail.
          shadow.prefix.splice(
            listIndex + 1,
            0,
            ...new Array<number>(insertCount).fill(0),
          );
          prefixRebuildTail(shadow, listIndex);
          listIndex += insertCount;
        }
      }

      // Soft invariant: shadow length tracks list length.
      if (shadow.entries.length !== text.nodes.length) {
        resync("shadow-length-mismatch");
        return;
      }

      queue(events);
      // Sync deliver for list deltas — do not wait for afterTransaction alone
      // (host ordering can defer it past the caller's next line).
      flushPending();
    } catch (err) {
      resync(err instanceof Error ? err.message : "observe-exception");
      flushPending();
    }
  };

  arr.observe(onArrayEvent);

  return () => {
    if (disposed) return;
    disposed = true;
    arr.unobserve(onArrayEvent);
    doc.off("afterTransaction", onAfterTransaction);
    for (const w of atomWatches.values()) w.unobserve();
    atomWatches.clear();
    pending = null;
  };
}

/**
 * Map TextEvents to plain-text replaces (for CM / any offset editor). Markers no-op.
 *
 * Offsets are **sequential**: each event is against the document state after prior
 * events in the same batch (shadow advanced as the Y delta was walked). Apply in
 * order with no extra shift — same as applying the model ops in order.
 */
export function textEventsToReplaces(events: TextEvent[]): {
  replaces: { from: number; to: number; insert: string }[];
  resync: boolean;
  markersChanged: boolean;
  resyncReason?: string;
} {
  const replaces: { from: number; to: number; insert: string }[] = [];
  let resync = false;
  let markersChanged = false;
  let resyncReason: string | undefined;
  for (const e of events) {
    if (e.type === "resync") {
      resync = true;
      resyncReason = e.reason;
      break;
    }
    if (e.type === "markers-changed") {
      markersChanged = true;
      continue;
    }
    if (e.type === "atoms-inserted") {
      replaces.push({ from: e.offset, to: e.offset, insert: e.text });
      continue;
    }
    if (e.type === "atoms-removed") {
      replaces.push({ from: e.from, to: e.to, insert: "" });
      continue;
    }
    if (e.type === "atom-text-replaced") {
      replaces.push({ from: e.from, to: e.to, insert: e.text });
    }
  }
  return { replaces, resync, markersChanged, resyncReason };
}
