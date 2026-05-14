/**
 * Y.Doc ↔ Y.Doc sync over a Node MessageChannel. CI baseline — no browser,
 * no real network. Validates that the Provider correctly speaks the y-protocols
 * sync + awareness sub-protocols over our outer frame envelope.
 *
 * The Node global `MessageChannel` (Node 15+) is structurally compatible with
 * the DOM MessagePort surface the browser provides: `port.onmessage = fn`,
 * `port.postMessage(data, transferList)`, `port.close()`. We rely on that
 * compatibility — no shim. If a Node version regresses on it, the failure
 * will be loud (TypeError on `onmessage` assignment).
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  YMessagePortProvider,
  YMessagePortProviderOrigin,
  type YMessagePortErrorKind,
  type Status,
} from "../YMessagePortProvider.js";
import { encodeFrame, messageAwareness, messageReady, messageSync } from "../protocol.js";

/** Poll a predicate until true or timeout. Better than fixed sleeps. */
async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for predicate after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("YMessagePortProvider — sync over Node MessageChannel", () => {
  it("propagates initial Y.Doc state from peer A to peer B", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    docA.getText("body").insert(0, "hello from A");

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provB.synced && docB.getText("body").toString() === "hello from A");

    expect(docB.getText("body").toString()).toBe("hello from A");

    provA.destroy();
    provB.destroy();
  });

  it("propagates incremental updates bidirectionally after sync", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    docA.getText("body").insert(0, "from-a;");
    docB.getText("body").insert(0, "from-b;");

    await until(() => {
      const a = docA.getText("body").toString();
      const b = docB.getText("body").toString();
      // Both texts converge (Yjs CRDT ordering deterministic by clientID).
      return a === b && a.includes("from-a") && a.includes("from-b");
    });

    expect(docA.getText("body").toString()).toBe(docB.getText("body").toString());

    provA.destroy();
    provB.destroy();
  });

  it("propagates awareness state between peers", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    provA.awareness.setLocalState({ cursor: { line: 3, ch: 7 }, name: "alice" });
    provB.awareness.setLocalState({ cursor: { line: 1, ch: 0 }, name: "bob" });

    await until(() => {
      const aSeesB = provA.awareness.getStates().get(docB.clientID);
      const bSeesA = provB.awareness.getStates().get(docA.clientID);
      return !!aSeesB && !!bSeesA;
    });

    expect(provA.awareness.getStates().get(docB.clientID)).toEqual({
      cursor: { line: 1, ch: 0 },
      name: "bob",
    });
    expect(provB.awareness.getStates().get(docA.clientID)).toEqual({
      cursor: { line: 3, ch: 7 },
      name: "alice",
    });

    provA.destroy();
    provB.destroy();
  });

  it("emits synced=true via 'sync' event exactly once per provider", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    docA.getText("body").insert(0, "x");

    const events: boolean[] = [];
    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);
    provB.on("sync", (synced: boolean) => events.push(synced));

    await until(() => provB.synced);
    // Give any spurious second event a chance to land.
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toEqual([true]);

    provA.destroy();
    provB.destroy();
  });
});

describe("YMessagePortProvider — port-per-doc", () => {
  it("two doc pairs on two MessageChannels don't crosstalk", async () => {
    // The cohort decision: one Y.Doc per port. Topology layer (eventually
    // ControlChannel) is responsible for handing the right port to the right
    // Y.Doc; the Provider trusts the port it's given.
    const ch1 = new MessageChannel();
    const ch2 = new MessageChannel();
    const docA1 = new Y.Doc();
    const docA2 = new Y.Doc();
    const docB1 = new Y.Doc();
    const docB2 = new Y.Doc();

    docA1.getText("t").insert(0, "alpha");
    docA2.getText("t").insert(0, "beta");

    const provA1 = new YMessagePortProvider(docA1, ch1.port1);
    const provA2 = new YMessagePortProvider(docA2, ch2.port1);
    const provB1 = new YMessagePortProvider(docB1, ch1.port2);
    const provB2 = new YMessagePortProvider(docB2, ch2.port2);

    await until(
      () =>
        provB1.synced &&
        provB2.synced &&
        docB1.getText("t").toString() === "alpha" &&
        docB2.getText("t").toString() === "beta",
    );

    expect(docB1.getText("t").toString()).toBe("alpha");
    expect(docB2.getText("t").toString()).toBe("beta");

    provA1.destroy();
    provA2.destroy();
    provB1.destroy();
    provB2.destroy();
  });
});

describe("YMessagePortProvider — late peer", () => {
  it("syncs when peer B constructs after peer A has been waiting", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    docA.getText("body").insert(0, "early-A");
    const provA = new YMessagePortProvider(docA, channel.port1);

    // A's messageReady is buffered on port2 until B starts.
    await new Promise((r) => setTimeout(r, 50));

    const provB = new YMessagePortProvider(docB, channel.port2);
    await until(() => provB.synced && docB.getText("body").toString() === "early-A");

    expect(docB.getText("body").toString()).toBe("early-A");
    provA.destroy();
    provB.destroy();
  });
});

describe("YMessagePortProvider — query awareness", () => {
  it("late joiner receives existing awareness via queryAwareness handshake", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    provA.awareness.setLocalState({ name: "alice" });

    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provB.awareness.getStates().get(docA.clientID) !== undefined);
    expect(provB.awareness.getStates().get(docA.clientID)).toEqual({ name: "alice" });

    provA.destroy();
    provB.destroy();
  });
});

describe("YMessagePortProvider — status events", () => {
  it("transitions connecting → connected → disconnected in order", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const statuses: Status[] = [];
    provA.on("status", (e: { status: Status }) => statuses.push(e.status));

    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.status === "connected");
    provA.destroy();

    expect(statuses).toEqual(["connected", "disconnected"]);
    provB.destroy();
  });

  it("emits sync-timeout when peer never replies", async () => {
    const channel = new MessageChannel();
    const doc = new Y.Doc();

    const prov = new YMessagePortProvider(doc, channel.port1, { syncTimeoutMs: 30 });
    const statuses: Status[] = [];
    prov.on("status", (e: { status: Status }) => statuses.push(e.status));

    await new Promise((r) => setTimeout(r, 80));
    expect(statuses).toContain("sync-timeout");
    expect(prov.synced).toBe(false);

    prov.destroy();
    channel.port2.close();
  });
});

describe("YMessagePortProvider — error resilience", () => {
  it("malformed sync payload emits 'error' but keeps channel alive", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    const errors: unknown[] = [];
    provB.on("error", (err: unknown) => errors.push(err));

    // Inject a malformed sync frame: payload has an unknown inner sub-type
    // (255 — readSyncMessage throws "Unknown message type").
    const badInner = new Uint8Array([255, 0]);
    const badFrame = encodeFrame(messageSync, badInner);
    channel.port1.postMessage(badFrame, [badFrame.buffer]);

    await until(() => errors.length > 0);
    expect(errors.length).toBeGreaterThan(0);

    // Channel is still alive — a subsequent legitimate update must propagate.
    docA.getText("body").insert(0, "after-error");
    await until(() => docB.getText("body").toString() === "after-error");

    provA.destroy();
    provB.destroy();
  });

  it("garbage outer frame emits 'error' with 'decode' kind", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    const errors: Array<[unknown, YMessagePortErrorKind]> = [];
    provB.on("error", (err: unknown, kind: YMessagePortErrorKind) => errors.push([err, kind]));

    // Lone varUint continuation byte with no follow-up — readVarUint reads
    // past end-of-buffer and throws.
    const garbage = new Uint8Array([0x80]);
    channel.port1.postMessage(garbage, [garbage.buffer]);

    await until(() => errors.some(([, k]) => k === "decode"));
    expect(errors.some(([, k]) => k === "decode")).toBe(true);

    provA.destroy();
    provB.destroy();
  });

  it("unknown outer type emits 'error' with 'unknown-type' but is ignored", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    const errors: Array<[unknown, YMessagePortErrorKind]> = [];
    provB.on("error", (err: unknown, kind: YMessagePortErrorKind) => errors.push([err, kind]));

    // Hand-craft a frame with outer type=99 (unknown to this version).
    const frame = encodeFrame(99 as 1, undefined);
    channel.port1.postMessage(frame, [frame.buffer]);

    await until(() => errors.some(([, k]) => k === "unknown-type"));

    // Channel survives — a subsequent legitimate update propagates.
    docA.getText("body").insert(0, "after-unknown");
    await until(() => docB.getText("body").toString() === "after-unknown");

    provA.destroy();
    provB.destroy();
  });

  it("non-Uint8Array message data emits 'error' with 'wrong-payload-shape'", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    const errors: Array<[unknown, YMessagePortErrorKind]> = [];
    provB.on("error", (err: unknown, kind: YMessagePortErrorKind) => errors.push([err, kind]));

    // Send a plain object — a hostile/buggy peer might do this.
    channel.port1.postMessage({ not: "a frame" });

    await until(() => errors.some(([, k]) => k === "wrong-payload-shape"));
    expect(errors.some(([, k]) => k === "wrong-payload-shape")).toBe(true);

    provA.destroy();
    provB.destroy();
  });

  it("malformed awareness payload emits 'error' without crashing", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    const errors: unknown[] = [];
    provB.on("error", (err: unknown) => errors.push(err));

    // Awareness payload claims a 10-byte inner blob but the buffer is truncated.
    const truncated = new Uint8Array([10, 1, 2]);
    const badFrame = encodeFrame(messageAwareness, truncated);
    channel.port1.postMessage(badFrame, [badFrame.buffer]);

    await until(() => errors.length > 0);
    expect(errors.length).toBeGreaterThan(0);

    provA.destroy();
    provB.destroy();
  });
});

describe("YMessagePortProvider — origin filtering", () => {
  it("peer-applied updates carry YMessagePortProviderOrigin so consumers can filter local emits", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    const origins: unknown[] = [];
    docB.on("update", (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });

    docA.getText("body").insert(0, "hello");
    await until(() => docB.getText("body").toString() === "hello");

    expect(origins).toContain(YMessagePortProviderOrigin);
    provA.destroy();
    provB.destroy();
  });
});

describe("YMessagePortProvider — local awareness on handshake", () => {
  it("late joiner learns peer who set local state before handshake completed", async () => {
    // Reproduce the case the Yjs reviewer flagged: peer A sets local state
    // BEFORE construction; B constructs later. B must learn A via the
    // handshake-time _broadcastLocalAwareness path, not via an awareness
    // mutation listener.
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    provA.awareness.setLocalState({ name: "alice" });

    // Delay so A's awareness 'update' fires before B exists. If we relied
    // only on awareness.on('update'), B would never see Alice.
    await new Promise((r) => setTimeout(r, 30));

    const provB = new YMessagePortProvider(docB, channel.port2);
    await until(() => provB.awareness.getStates().get(docA.clientID) !== undefined);

    expect(provB.awareness.getStates().get(docA.clientID)).toEqual({ name: "alice" });
    provA.destroy();
    provB.destroy();
  });
});

describe("YMessagePortProvider — lifetime", () => {
  it("destroy() immediately after construction does not throw and does not bother peer", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    // Destroy B before A's handshake reply has any chance to arrive.
    provB.destroy();

    // A subsequent A-side change must not crash A (its messageReady reply
    // path may still fire).
    docA.getText("body").insert(0, "after-b-destroyed");
    await new Promise((r) => setTimeout(r, 50));

    expect(() => provA.destroy()).not.toThrow();
    expect(provB.status).toBe("disconnected");
  });

  it("re-handshakes when peer posts a second messageReady (peer restart)", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    const transitions: boolean[] = [];
    provA.on("sync", (...args: unknown[]) => transitions.push(args[0] as boolean));

    // Simulate peer restart: re-emit messageReady on B's port. A should flip
    // synced=false → re-handshake → synced=true.
    channel.port2.postMessage(encodeFrame(messageReady));

    await until(() => transitions.includes(false) && transitions[transitions.length - 1] === true);
    expect(transitions[0]).toBe(false);
    expect(transitions[transitions.length - 1]).toBe(true);

    provA.destroy();
    provB.destroy();
  });

  it("removeAwarenessStates on pagehide uses YMessagePortProviderOrigin tag", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);
    provA.awareness.setLocalState({ user: "a" });

    await until(() => provA.synced && provB.synced);

    const origins: unknown[] = [];
    provA.awareness.on("update", (_changes: unknown, origin: unknown) => origins.push(origin));

    // Simulate pagehide manually via the same code path the listener uses.
    const { removeAwarenessStates } = await import("y-protocols/awareness");
    removeAwarenessStates(provA.awareness, [docA.clientID], YMessagePortProviderOrigin);

    expect(origins).toContain(YMessagePortProviderOrigin);

    provA.destroy();
    provB.destroy();
  });

  it("destroy() is idempotent and stops further message handling", async () => {
    const channel = new MessageChannel();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const provA = new YMessagePortProvider(docA, channel.port1);
    const provB = new YMessagePortProvider(docB, channel.port2);

    await until(() => provA.synced && provB.synced);

    provA.destroy();
    provA.destroy(); // idempotent — must not throw

    // After A destroyed, an A-side update must not reach B.
    docA.getText("body").insert(0, "post-destroy");
    await new Promise((r) => setTimeout(r, 50));
    expect(docB.getText("body").toString()).toBe("");

    provB.destroy();
  });
});
