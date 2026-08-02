# `@here.build/y-control-channel`

Port-routing control plane over a `MessagePort`. Allocates per-resource `MessageChannel`s, transfers one end to the peer, and carries small control messages (`hello`, `open`, `close`, `ping`, `pong`, `status`, `error`). Yjs-agnostic — composes with `@here.build/y-messageport` but doesn't import Yjs.

```ts
import { ControlChannel } from "@here.build/y-control-channel";

// Side A (tab):
const control = new ControlChannel(sharedWorker.port);
control.on("status", (hop, status) => uiStore.setHopStatus(hop, status));

const docPort = control.open(`doc:${uuid}`);
// hand docPort to whatever needs it — typically a YMessagePortProvider

// Side B (SharedWorker):
control.on("open", (id, port) => {
  const doc = getOrLazyProvisionDoc(id);
  new YMessagePortProvider(doc, port);
});
wsProvider.on("status", ({ status }) => control.postStatus("ws", status));
```

## Why a separate primitive

Routing per-doc traffic over a single shared port via prefix multiplexing is the obvious bad solution: every middleman has to decode bytes to know which doc a frame belongs to. Per-doc `MessagePort`s transferred via this control plane give a free **middleman-ignorance property** — proxies forward ports without ever looking at the bytes that flow through them.

Cohort precedent (Liveblocks rooms, Hocuspocus documents, Automerge `DocHandle`s, Supabase channels) puts routing primitives at the application API layer, not on the wire.

## Control message taxonomy

```ts
type ControlMessage =
  | { kind: "hello"; proto: "y-control/1" }
  | { kind: "open"; id: string }                    // MessagePort in transfer list
  | { kind: "close"; id: string }                   // advisory — receiver decides
  | { kind: "ping"; nonce: number }
  | { kind: "pong"; nonce: number }
  | { kind: "status"; hop: string; status: string } // app-defined hop names
  | { kind: "error"; reason: string };
```

Transport: plain structured-clone JS objects (no lib0 framing). Control traffic is low-frequency and structured. Doc ports — the things `open()` allocates — are where the bursty lib0-encoded y-protocols traffic lives.

## API

```ts
new ControlChannel(port: MessagePort, options?: { heartbeatMs?: number })
```

Construct once per port-end. Both sides post `hello` on construction.

- `open(id: string): MessagePort` — allocate a fresh `MessageChannel`, transfer `port2` to peer in an `open` message, return `port1`. Duplicate `id` on the same side throws.
- `close(id: string): void` — advisory. Peer receives a `close` event but does NOT auto-tear-down. Multi-tab scenarios depend on this.
- `postStatus(hop: string, status: string): void` — forward an upstream hop's status. App-defined `hop` labels.
- `get lastSeenMs: number` — wall-clock of the most recent inbound control message. Consumer applies its own liveness threshold.
- `destroy(): void` — stops heartbeat + detaches listeners. Does NOT close the underlying port (caller owns it).

Events (`Observable` interface from `lib0`):

- `hello` — peer's hello arrived.
- `open(id, port)` — peer opened a resource and transferred its end.
- `close(id)` — peer advised close.
- `status(hop, status)` — peer forwarded hop status.
- `ping(nonce)` / `pong(nonce)` — heartbeat traffic.
- `error(err, kind, raw?)` — kinds: `wrong-payload-shape`, `duplicate-open`, `messageerror`, `peer-error`.

## Multi-hop status pattern

Status from each hop travels independently with its own `hop` label. **No boolean is aggregated on the wire.** Firebase-style multi-hop status lies (flaps after sleep, lags 30+s after real disconnect) become impossible by construction.

```
SharedWorker  --[control]-->  top frame  --[control]-->  host iframe
   |                             |                            |
   wsProvider.status              forwards "ws" status         renders UI from
   → control.postStatus("ws")     unchanged                    three signals:
                                  forwards own "worker"        - hop 1
                                  status                       - hop 2
                                                               - hop 3 (ws)
```

A middleman is ~10 lines: receive `open` from one side, immediately re-open on the other side and pipe `postMessage` both ways between the two doc ports. No Yjs imports needed.

## Heartbeat

Default 30 s. Set `heartbeatMs: 0` to disable. Doc ports stay quiet between Yjs bursts; if you want to know whether the peer is alive without per-doc liveness checks, leave heartbeat on. The receiver echoes `ping` as `pong` automatically; both sides observe `lastSeenMs()` advancing.

## Lifetime ownership

- **Port:** not owned. Caller created it, caller closes it. `destroy()` only detaches listeners and stops the heartbeat.
- **Allocated doc ports:** owned by whoever attaches them. Returning a port from `open()` hands ownership to the caller; receiving a port from an `open` event hands it to the listener.

## Worked example — tab ↔ SharedWorker ↔ WebSocket

One `ControlChannel` per hop, per-doc `MessagePort`s transferred along the chain, middlemen with zero Yjs imports.

```
┌────────┐  control + N doc ports  ┌──────────────┐   WebSocket    ┌──────────┐
│  Tab   │ ───────────────────────▶│ SharedWorker │ ──────────────▶│ y-ws hub │
│ (UI)   │ ◀───────────────────────│   (hub)      │ ◀──────────────│ (server) │
└────────┘                         └──────────────┘                └──────────┘
```

The tab opens `doc:abc`; the SharedWorker lazily provisions a `Y.Doc` + WebSocket subscription for that id and binds them with `YMessagePortProvider`; the tab binds its own `Y.Doc` to the local end. Sync, awareness, and status all flow — no prefix multiplexing on any wire.

**Tab side:**

```ts
const control = new ControlChannel(worker.port);

const hopStatus = new Map<string, string>();
control.on("status", (hop, status) => {
  hopStatus.set(hop, status);
  rerenderConnectivityIndicator(hopStatus); // UI composes per-hop signals — no wire aggregation
});

const doc = new Y.Doc();
const docPort = control.open("doc:abc"); // fresh MessageChannel; peer end transferred
const provider = new YMessagePortProvider(doc, docPort);

window.addEventListener("pagehide", () => {
  control.close("doc:abc");
  provider.destroy();
  docPort.close(); // lets the worker observe port death and release
});
```

**SharedWorker side** — refcounted doc provisioning plus a per-tab reaper:

```ts
const docs = new Map<string, { doc: Y.Doc; ws: WebsocketProvider; refcount: number }>();
const reapers = new Map<ControlChannel, () => void>();

function getOrProvision(id: string) {
  let entry = docs.get(id);
  if (!entry) {
    const doc = new Y.Doc();
    const ws = new WebsocketProvider("wss://sync.here.build", id, doc);
    entry = { doc, ws, refcount: 0 };
    docs.set(id, entry);
    // Per-doc hop label — a single "ws connected" boolean would lie when one
    // doc is healthy and another isn't (the canonical Firebase failure).
    ws.on("status", (e: { status: string }) => {
      for (const c of reapers.keys()) c.postStatus(`ws:${id}`, e.status);
    });
  }
  return entry;
}

function release(id: string) {
  const entry = docs.get(id);
  if (!entry || --entry.refcount > 0) return;
  // Delete from the map BEFORE async destroy — a tab connecting while
  // ws.destroy() is in flight gets a fresh entry, not a half-torn-down one.
  docs.delete(id);
  entry.ws.destroy();
  entry.doc.destroy();
}

(self as unknown as SharedWorkerGlobalScope).onconnect = (ev) => {
  const control = new ControlChannel(ev.ports[0]);
  const owned = new Set<string>();

  const reapTab = () => {
    if (!reapers.delete(control)) return;
    for (const id of owned) release(id);
    owned.clear();
    control.destroy();
  };
  reapers.set(control, reapTab);

  control.on("open", (id, docPort) => {
    const entry = getOrProvision(id);
    entry.refcount += 1;
    owned.add(id);
    new YMessagePortProvider(entry.doc, docPort);
  });
  control.on("close", (id) => {
    if (owned.delete(id)) release(id);
  });
  control.on("error", (_err, kind) => {
    if (kind === "messageerror" || kind === "peer-error") reapTab();
  });

  control.postStatus("worker", "ready");
};

// MessagePort has no connection-close event; a crashed tab leaves its port
// silently dead. Reap on heartbeat silence:
setInterval(() => {
  const now = Date.now();
  for (const [control, reap] of reapers) {
    if (now - control.lastSeenMs > 90_000) reap();
  }
}, 30_000);
```

**The 10-line middleman** — a proxy hop (e.g. a top frame between tab and SharedWorker) that never imports Yjs, never decodes a lib0 frame; doc ports are pure byte pipes through it:

```ts
function pipe(a: ControlChannel, b: ControlChannel): void {
  a.on("open", (id, port) => bridge(port, b.open(id)));
  a.on("close", (id) => b.close(id));
  a.on("status", (hop, status) => b.postStatus(hop, status));
  b.on("open", (id, port) => bridge(port, a.open(id)));
  b.on("close", (id) => a.close(id));
  b.on("status", (hop, status) => a.postStatus(hop, status));
}

function bridge(p1: MessagePort, p2: MessagePort): void {
  p1.addEventListener("message", (ev) => p2.postMessage(ev.data));
  p2.addEventListener("message", (ev) => p1.postMessage(ev.data));
  p1.start();
  p2.start();
}
```

A production middleman receiving its tab port via `window.postMessage` MUST allowlist `ev.origin` — checking `ev.source === parent` alone is bypassable when the embedding page is hostile.

**Reconnect semantics.** ControlChannel does not handle WebSocket reconnect — that's the ws provider's job, inside the worker:

- WebSocket drops → worker forwards `postStatus("ws:doc:abc", "connecting")` → tab updates UI. The doc port itself never broke; on reconnect, Yjs's own handshake resyncs over the existing port.
- SharedWorker itself dies (eviction, unsupported platform) → tab observes `lastSeenMs` stalling, then port errors. Recovery: tear down the local `ControlChannel`, connect a fresh `SharedWorker`, open fresh doc ports; the Yjs handshake handles resync.

**Browser substrate caveats.** iOS Safari < 16.4 and Chromium Android < 148 lack SharedWorker — fall back to a dedicated Worker per tab + Web Locks leader election. SharedWorker eviction under memory pressure happens even with live tabs; treat worker death as steady-state recovery, not an edge case.

## Tests

`pnpm test` runs the CI baseline against Node's `MessageChannel`: hello round-trip, open with port handoff, advisory close, heartbeat, status forwarding, error resilience (wrong payload shape, duplicate open from peer), destroy idempotency.

## See also

- `@here.build/y-messageport` — Yjs sync + awareness Provider over a single MessagePort.
