/**
 * Lane staleness — what survives 60s of silence.
 *
 * Only channel 0 heartbeats (every `outdatedTimeout / 2`). Field lanes sleep
 * until their value changes, so their `meta.lastUpdated` goes arbitrarily
 * stale. The GC must therefore time out on channel 0 ONLY: a lane that has
 * not been rewritten in an hour is not gone, it is merely quiet.
 *
 * The failure this guards: GC that walks all channels would evict a live
 * peer's cursor lane while the peer is still present and heartbeating.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// `lib0/time` is `export const getUnixTime = Date.now` — a reference captured at
// import, so vitest's faked `Date` never reaches it and every elapsed-time check
// inside awareness reads real wall-clock. Re-export it as a call-time lookup so
// `advanceTimersByTime` actually drives the heartbeat and the GC. Without this
// the tests below pass vacuously: the interval fires, every delta is ~0, and
// nothing is ever collected.
vi.mock("lib0/time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lib0/time")>();
  return { ...actual, getUnixTime: () => Date.now() };
});

import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  outdatedTimeout,
  PlexusAwareness,
} from "../../awareness.js";

const MINUTE = 60_000;

describe("awareness lanes after prolonged silence", () => {
  const docs: Y.Doc[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
    vi.useRealTimers();
  });

  function make(): PlexusAwareness {
    const doc = new Y.Doc();
    docs.push(doc);
    return new PlexusAwareness(doc);
  }

  it("keeps local lane values readable after 60s with no writes", () => {
    const aw = make();
    aw.setField("cursor", { x: 1, y: 2 });
    aw.setField("selection", ["node-1"]);

    vi.advanceTimersByTime(MINUTE);

    expect(aw.getField("cursor")).toEqual({ x: 1, y: 2 });
    expect(aw.getField("selection")).toEqual(["node-1"]);
    expect(aw.getSchema()).toEqual(["cursor", "selection"]);
  });

  it("keeps a heartbeating peer's lanes readable after 60s of lane silence", () => {
    const local = make();
    const peer = make();

    // A provider forwards everything the peer emits — including the bare
    // channel-0 heartbeat, which is the only frame it sends while idle.
    const forward = (payload: { added: number[]; updated: number[]; removed: number[] }): void => {
      const ids = [...payload.added, ...payload.updated, ...payload.removed];
      if (ids.length === 0) return;
      applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, ids), "remote");
    };
    peer.on("update", forward);

    peer.setField("cursor", { x: 7, y: 9 });
    expect(local.getField("cursor", peer.clientID)).toEqual({ x: 7, y: 9 });

    // A full minute in which the peer writes no field at all — only heartbeats.
    vi.advanceTimersByTime(MINUTE);

    expect(local.getPeerIds()).toContain(peer.clientID);
    expect(local.getField("cursor", peer.clientID)).toEqual({ x: 7, y: 9 });
    expect(local.getPeer(peer.clientID)).toEqual({ cursor: { x: 7, y: 9 } });
  });

  it("drops every lane of a peer that stops heartbeating", () => {
    const local = make();
    const peer = make();

    peer.setField("cursor", { x: 7, y: 9 });
    peer.setField("selection", ["a"]);
    applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [...peer.states.keys()]), "remote");
    expect(local.getPeerIds()).toContain(peer.clientID);

    // No forwarding: the peer goes silent from `local`'s point of view.
    vi.advanceTimersByTime(outdatedTimeout * 2);

    expect(local.getPeerIds()).not.toContain(peer.clientID);
    expect(local.getPeer(peer.clientID)).toBeNull();
    expect(local.getField("cursor", peer.clientID)).toBeUndefined();

    // No orphaned field channels left behind in the states map.
    const orphans = [...local.states.keys()].filter(
      (cid) => local.resolveKey(cid)?.base === peer.clientID,
    );
    expect(orphans).toEqual([]);
  });
});
