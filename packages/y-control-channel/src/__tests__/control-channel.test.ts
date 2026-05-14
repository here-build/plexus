/**
 * ControlChannel test suite — Node MessageChannel baseline.
 *
 * Validates:
 *   - symmetric hello on construction
 *   - open() allocates + transfers a per-resource MessagePort, peer receives it
 *   - close is advisory (event fires, no auto-teardown)
 *   - heartbeat ping/pong + lastSeenMs updates
 *   - status forwarding (no aggregation on the wire)
 *   - error paths: duplicate open (local + peer), wrong-payload-shape
 *   - destroy() is idempotent, does not close the port
 *   - ports allocated via open() carry payloads end-to-end
 */
import { describe, expect, it } from "vitest";

import { ControlChannel } from "../ControlChannel.js";
import type { ControlChannelErrorKind } from "../ControlChannel.js";

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for predicate after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ControlChannel — handshake", () => {
  it("both sides emit 'hello' after construction", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    let aHello = false;
    let bHello = false;
    a.on("hello", () => {
      aHello = true;
    });
    b.on("hello", () => {
      bHello = true;
    });

    await until(() => aHello && bHello);
    expect(aHello).toBe(true);
    expect(bHello).toBe(true);

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — open / close", () => {
  it("open() transfers a fresh MessagePort to peer with matching id", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const received: Array<[string, MessagePort]> = [];
    b.on("open", (id: string, port: MessagePort) => {
      received.push([id, port]);
    });

    const aDocPort = a.open("doc:abc");
    expect(aDocPort).toBeDefined();

    await until(() => received.length > 0);
    expect(received[0][0]).toBe("doc:abc");
    expect(received[0][1]).toBeDefined();

    // Validate the allocated channel is actually wired: send a payload from a side,
    // receive on b side.
    const bDocPort = received[0][1];
    const payloads: unknown[] = [];
    bDocPort.addEventListener("message", (ev: MessageEvent) => {
      payloads.push(ev.data);
    });
    bDocPort.start();
    aDocPort.postMessage("ping-payload");

    await until(() => payloads.length > 0);
    expect(payloads[0]).toBe("ping-payload");

    aDocPort.close();
    bDocPort.close();
    a.destroy();
    b.destroy();
  });

  it("close() is advisory — peer receives event, doc port stays open", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    let bSawClose = false;
    let bClosedId: string | null = null;
    b.on("close", (id: string) => {
      bSawClose = true;
      bClosedId = id;
    });

    const aDocPort = a.open("doc:zzz");
    let bDocPort: MessagePort | null = null;
    b.on("open", (_id: string, port: MessagePort) => {
      bDocPort = port;
    });

    await until(() => bDocPort !== null);

    a.close("doc:zzz");
    await until(() => bSawClose);
    expect(bClosedId).toBe("doc:zzz");

    // The doc port is NOT auto-closed by the control plane. Caller policy.
    expect(bDocPort).not.toBeNull();
    const payloads: unknown[] = [];
    bDocPort!.addEventListener("message", (ev: MessageEvent) => {
      payloads.push(ev.data);
    });
    bDocPort!.start();
    aDocPort.postMessage("still-alive");
    await until(() => payloads.length > 0);
    expect(payloads[0]).toBe("still-alive");

    aDocPort.close();
    bDocPort!.close();
    a.destroy();
    b.destroy();
  });

  it("duplicate open() on same side throws and emits 'error' duplicate-open", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });

    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    a.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));

    a.open("doc:dup");
    expect(() => a.open("doc:dup")).toThrow(/duplicate open/);
    expect(errors.some(([, k]) => k === "duplicate-open")).toBe(true);

    a.destroy();
    ch.port2.close();
  });
});

describe("ControlChannel — warmup / setFocus", () => {
  it("warmup() delivers id + priority to peer; repeat calls re-emit", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const seen: Array<[string, "low" | "high"]> = [];
    b.on("warmup", (id: string, priority: "low" | "high") => seen.push([id, priority]));

    a.warmup("doc:x", "low");
    a.warmup("doc:x", "high"); // upgrade — peer sees both, policy is its problem
    a.warmup("doc:y", "low");

    await until(() => seen.length >= 3);
    expect(seen).toEqual([
      ["doc:x", "low"],
      ["doc:x", "high"],
      ["doc:y", "low"],
    ]);

    a.destroy();
    b.destroy();
  });

  it("setFocus() delivers focused state to peer", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const seen: boolean[] = [];
    b.on("setFocus", (focused: boolean) => seen.push(focused));

    a.setFocus(true);
    a.setFocus(false);
    a.setFocus(true);

    await until(() => seen.length >= 3);
    expect(seen).toEqual([true, false, true]);

    a.destroy();
    b.destroy();
  });

  it("malformed warmup payload (bad priority) emits wrong-payload-shape", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    b.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));

    // Bypass typed API: post a warmup with a non-enum priority.
    ch.port1.postMessage({ kind: "warmup", id: "doc:z", priority: "urgent" });

    await until(() => errors.some(([, k]) => k === "wrong-payload-shape"));

    a.destroy();
    b.destroy();
  });

  it("malformed setFocus payload (non-boolean) emits wrong-payload-shape", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    b.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));

    ch.port1.postMessage({ kind: "setFocus", focused: "yes" });

    await until(() => errors.some(([, k]) => k === "wrong-payload-shape"));

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — heartbeat", () => {
  it("ping/pong round-trip + lastSeenMs advances", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 20 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const beforeA = a.lastSeenMs;
    const beforeB = b.lastSeenMs;

    // Wait long enough for at least one ping cycle to traverse a → b → a.
    await new Promise((r) => setTimeout(r, 80));

    expect(a.lastSeenMs).toBeGreaterThan(beforeA);
    expect(b.lastSeenMs).toBeGreaterThan(beforeB);

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — status forwarding", () => {
  it("postStatus delivers hop+status to peer, no aggregation", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const seen: Array<[string, string]> = [];
    b.on("status", (hop: string, status: string) => seen.push([hop, status]));

    a.postStatus("ws", "connected");
    a.postStatus("ws", "disconnected");
    a.postStatus("indexeddb", "ready");

    await until(() => seen.length >= 3);
    expect(seen).toEqual([
      ["ws", "connected"],
      ["ws", "disconnected"],
      ["indexeddb", "ready"],
    ]);

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — error resilience", () => {
  it("non-ControlMessage payload emits 'error' wrong-payload-shape, channel survives", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    b.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));

    // Hostile/buggy peer behavior: bypass the ControlChannel API and post a
    // raw object directly on the underlying port.
    ch.port1.postMessage({ kind: "not-a-real-kind" });

    await until(() => errors.some(([, k]) => k === "wrong-payload-shape"));

    // Channel still works — a subsequent legitimate status traverses.
    const seenStatus: Array<[string, string]> = [];
    b.on("status", (hop: string, status: string) => seenStatus.push([hop, status]));
    a.postStatus("ws", "connected");
    await until(() => seenStatus.length > 0);

    a.destroy();
    b.destroy();
  });

  it("peer sends duplicate open id → 'error' duplicate-open, no spurious open event", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const opens: string[] = [];
    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    b.on("open", (id: string) => opens.push(id));
    b.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));

    // First open from a — legitimate.
    a.open("doc:x");

    await until(() => opens.length === 1);

    // Now bypass `a`'s duplicate-open guard by hand-crafting on the raw port.
    // (Simulates a buggy peer or a race where two control channels share a port id.)
    const { port2 } = new MessageChannel();
    ch.port1.postMessage({ kind: "open", id: "doc:x" }, [port2]);

    await until(() => errors.some(([, k]) => k === "duplicate-open"));
    // No new open event for the duplicate.
    expect(opens.length).toBe(1);

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — open without port", () => {
  it("peer-sent open without a transferred port emits wrong-payload-shape", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    const opens: string[] = [];
    b.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));
    b.on("open", (id: string) => opens.push(id));

    // Hand-craft an `open` frame with no transferred port.
    ch.port1.postMessage({ kind: "open", id: "doc:no-port" });

    await until(() => errors.some(([, k]) => k === "wrong-payload-shape"));
    expect(opens).toHaveLength(0);

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — heartbeat lifetime", () => {
  it("heartbeat stops firing after destroy()", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 20 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    let pings = 0;
    b.on("ping", () => pings++);

    await until(() => pings >= 2);
    a.destroy();
    const after = pings;

    await new Promise((r) => setTimeout(r, 80));
    expect(pings).toBe(after);

    b.destroy();
  });
});

describe("ControlChannel — liveness invariants", () => {
  it("lastSeenMs does NOT advance on a wrong-payload-shape frame", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    // Wait for initial hello to settle baseline.
    await new Promise((r) => setTimeout(r, 20));
    const baseline = b.lastSeenMs;

    await new Promise((r) => setTimeout(r, 30));
    ch.port1.postMessage({ kind: "not-real" });

    const errors: Array<[unknown, ControlChannelErrorKind]> = [];
    b.on("error", (err: unknown, kind: ControlChannelErrorKind) => errors.push([err, kind]));
    await until(() => errors.some(([, k]) => k === "wrong-payload-shape"));

    expect(b.lastSeenMs).toBe(baseline);

    a.destroy();
    b.destroy();
  });
});

describe("ControlChannel — lifetime", () => {
  it("destroy() is idempotent and does not close the underlying port", async () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    const b = new ControlChannel(ch.port2, { heartbeatMs: 0 });

    a.destroy();
    expect(() => a.destroy()).not.toThrow();

    // The raw port is still usable by the caller — control channel doesn't own it.
    const payloads: unknown[] = [];
    ch.port1.addEventListener("message", (ev: MessageEvent) => {
      payloads.push(ev.data);
    });
    ch.port1.start();
    // Send a raw message via b's underlying port (bypass the destroyed channel API).
    ch.port2.postMessage({ kind: "status", hop: "raw", status: "ok" });
    await until(() => payloads.length > 0);

    b.destroy();
    ch.port1.close();
    ch.port2.close();
  });

  it("open() after destroy() throws", () => {
    const ch = new MessageChannel();
    const a = new ControlChannel(ch.port1, { heartbeatMs: 0 });
    a.destroy();
    expect(() => a.open("doc:y")).toThrow();
    ch.port2.close();
  });
});
