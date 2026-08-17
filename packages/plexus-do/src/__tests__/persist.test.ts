import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { GENESIS_ORIGIN, REHYDRATE_ORIGIN } from "../constants.js";
import { PersistScheduler, applyRehydrate, encodeStateSince, shouldIgnoreUpdateOrigin } from "../persist.js";

describe("PersistScheduler", () => {
  it("debounce target advances only when earlier than existing alarm", () => {
    const scheduler = new PersistScheduler({ debounceMs: 5_000, ceilingMs: 30_000 }, {
      now: () => 1_000_000,
    });
    scheduler.markDirty("prime");
    const first = scheduler.nextAlarmTarget(null);
    expect(first).toBe(1_005_000);

    const later = scheduler.nextAlarmTarget(1_004_000);
    expect(later).toBe(1_004_000);
  });

  it("ceiling caps debounce during continuous editing", () => {
    let now = 0;
    const scheduler = new PersistScheduler({ debounceMs: 5_000, ceilingMs: 10_000 }, {
      now: () => now,
    });
    scheduler.markDirty("prime");
    scheduler.markPersisted("prime", 1);
    now = 9_000;
    scheduler.markDirty("prime");
    const target = scheduler.nextAlarmTarget(null);
    expect(target).toBe(10_000);
  });

  it("skips alarm scheduling in test mode", () => {
    const scheduler = new PersistScheduler({ debounceMs: 1_000 }, { testMode: true });
    scheduler.markDirty("prime");
    expect(scheduler.nextAlarmTarget(null)).toBeNull();
  });

  it("re-arms when an edit lands mid-persist (version race — no lost edit)", () => {
    const scheduler = new PersistScheduler({ debounceMs: 1_000 }, { now: () => 0 });
    scheduler.markDirty("prime"); // dirtyVersion = 1
    const versionAtSnapshot = scheduler.versionAtSnapshot("prime"); // captured before the async put
    scheduler.markDirty("prime"); // edit arrives during the await → dirtyVersion = 2
    scheduler.markPersisted("prime", versionAtSnapshot); // persistedVersion = 1
    // 2 > 1 → still dirty, so the alarm re-arms instead of falsely marking clean.
    expect(scheduler.hasPendingWork("prime")).toBe(true);
  });

  it("marks clean when no edit lands during persist", () => {
    const scheduler = new PersistScheduler({ debounceMs: 1_000 }, { now: () => 0 });
    scheduler.markDirty("prime");
    const versionAtSnapshot = scheduler.versionAtSnapshot("prime");
    scheduler.markPersisted("prime", versionAtSnapshot);
    expect(scheduler.hasPendingWork("prime")).toBe(false);
  });
});

describe("rehydrate origin", () => {
  it("tags storage replay so listeners can ignore it", () => {
    const source = new Y.Doc();
    source.getMap("root").set("k", 1);

    const doc = new Y.Doc();
    let seenOrigin: unknown;
    doc.on("update", (_u, origin) => {
      seenOrigin = origin;
    });
    applyRehydrate(doc, Y.encodeStateAsUpdate(source));
    expect(seenOrigin).toBe(REHYDRATE_ORIGIN);
    expect(shouldIgnoreUpdateOrigin(seenOrigin)).toBe(true);
    expect(shouldIgnoreUpdateOrigin(GENESIS_ORIGIN)).toBe(true);
    expect(shouldIgnoreUpdateOrigin("peer")).toBe(false);
  });
});

describe("encodeStateSince", () => {
  it("treats an empty horizon as 'full doc', not a 0-byte state vector", () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("k", 1);

    expect(() => Y.encodeStateAsUpdate(doc, new Uint8Array())).toThrow();

    const full = encodeStateSince(doc, new Uint8Array());
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, full);
    expect(decoded.getMap("root").get("k")).toBe(1);
  });

  it("encodes only missing ops against a real state vector", () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("a", 1);
    const snapshot = Y.encodeStateAsUpdate(doc);
    const horizon = Y.encodeStateVector(doc);
    doc.getMap("root").set("b", 2);

    const diff = encodeStateSince(doc, horizon);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, snapshot);
    Y.applyUpdate(peer, diff);
    expect(peer.getMap("root").get("b")).toBe(2);
  });
});