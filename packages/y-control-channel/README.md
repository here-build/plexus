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

Cohort precedent (Liveblocks rooms, Hocuspocus documents, Automerge `DocHandle`s, Supabase channels) puts routing primitives at the application API layer, not on the wire. See `docs/package-specific/y-control-channel/y-messageport-control-channel.md` for the synthesis.

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

## Tests

`pnpm test` runs the CI baseline against Node's `MessageChannel`: hello round-trip, open with port handoff, advisory close, heartbeat, status forwarding, error resilience (wrong payload shape, duplicate open from peer), destroy idempotency.

## See also

- `@here.build/y-messageport` — Yjs sync + awareness Provider over a single MessagePort.
- `docs/package-specific/y-control-channel/y-messageport-control-channel.md` — design synthesis.
