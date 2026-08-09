# `@here.build/y-messageport`

Yjs sync + awareness Provider over `MessagePort`. Universal bus extender — wire any `Y.Doc` to any port (DedicatedWorker, SharedWorker, cross-frame `MessageChannel`, anything that quacks like a `MessagePort`).

```ts
import * as Y from "yjs";
import { YMessagePortProvider } from "@here.build/y-messageport";

const doc = new Y.Doc();
const provider = new YMessagePortProvider(doc, port);
// optional: { awareness: existingAwareness } to share a cursor tracker
// One Y.Doc per port. To route multiple docs over one transport, use a
// ControlChannel-style topology layer that transfers per-doc MessagePorts.

provider.on("sync", (synced: boolean) => { /* initial replication done */ });

// when finished:
provider.destroy();         // detaches listeners on doc/awareness/port
// port.close();             // caller owns the port; close it yourself
```

## Wire protocol

Outer envelope (this package):

```
[ type: varUint ] [ payload: bytes... ]
```

Outer message types:

| Code | Name                  | Payload                                       |
|------|-----------------------|-----------------------------------------------|
| 1    | `messageReady`        | (none — handshake ping)                       |
| 2    | `messageSync`         | y-protocols sync sub-message (step1/step2/upd)|
| 3    | `messageAwareness`    | y-protocols awareness update                  |
| 4    | `messageQueryAwareness` | (none — request full awareness from peer)   |

`0` is reserved (never a valid message type) — varUint `0` is a clean mismatch sentinel rather than a silent type collision. `5` is reserved for forward-compat — currently decodes as `unknown-type` (non-fatal); see `protocol.ts` for the historical rationale (superseded by the ControlChannel design).

Handshake: both sides post `messageReady` on construction. On receiving the peer's `messageReady`, each side fires `syncStep1` + `messageQueryAwareness` + (if any) its current awareness state. Symmetric — either side may construct first.

One Y.Doc per port. The transport carries exactly one Y.Doc — no multiplexing on the wire. Routing multiple docs over a single transport is the responsibility of a topology layer (e.g. `y-control-channel`) that allocates per-doc `MessageChannel`s and transfers one port-end to each side. This gives free middleman-ignorance: proxies forward ports without ever decoding bytes. `addEventListener("message")` is used rather than `port.onmessage` because the latter is single-slot and would compose poorly with caller-attached listeners.

## Lifetime ownership

The Provider owns nothing it didn't allocate:

- **Y.Doc**: not owned. Caller's responsibility to destroy.
- **MessagePort**: not owned. Caller created it, caller closes it. The topology layer that allocated the per-doc port is responsible for its closure.
- **Awareness**: owned only when not supplied via options. If you pass `{ awareness }`, you own it.

### Lifecycle inside workers

The Provider auto-cleans local awareness on `pagehide` **only when running in a window context** (`typeof window !== "undefined"`). There is no `pagehide` inside `DedicatedWorker` / `SharedWorker` / `ServiceWorker` scopes.

If you construct a Provider inside a worker, you must invoke `provider.destroy()` yourself when the worker is shutting down. The recommended client-side pattern: on the window side, listen for `pagehide` (or `visibilitychange === "hidden"` for bfcache restore-safety) and `port.postMessage({ shutdown: true })` to the worker; the worker reacts by destroying its Provider so peers see a clean awareness departure.

There is no `connection-close` event. Two reasons, neither is "missing feature":

1. **`MessagePort` has no close notification at the platform level.** Unlike WebSocket's `close` DOM event, MessagePort gives the receiver no signal when the sender is gone. If you need one, ship it in-band before calling `destroy()`.
2. **Yjs has no single ecosystem-wide "I'm offline" signal.** Each provider exposes its own — y-websocket has `status` plus `connection-close`; y-webrtc has its own surface; y-indexeddb has none. The `status` event here mirrors y-websocket's `connecting` / `connected` / `disconnected`, scoped to this single hop. Aggregating liveness across multiple hops (`tab ↔ SharedWorker ↔ WebSocket ↔ server`) into a single boolean is a known anti-pattern — Firebase's `.info/connected` is the canonical horror story (flaps after sleep, lies after auth failure, lags 30+s after real disconnect). If you need multi-hop status, expose per-hop signals and let the consumer apply a threshold; don't collapse them at the transport.

## Origin filtering

The Provider applies peer updates with a tagged transaction origin. If your code listens to `doc.on("update", ...)` and needs to skip updates that came in over the wire (e.g., to avoid an echo loop when forwarding to a different transport), import and compare:

```ts
import { YMessagePortProviderOrigin } from "@here.build/y-messageport";

doc.on("update", (update, origin) => {
  if (origin === YMessagePortProviderOrigin) return; // came from a peer, ignore
  // ...local-only handling
});
```

The same symbol is used for awareness updates.

## Tests

Default `pnpm test` runs the CI baseline in Node using the global `MessageChannel` (Node 15+ DOM-compatible surface): wire-protocol round-trip, two-Y.Doc sync, awareness propagation, port-per-doc isolation, destroy idempotency. Browser-free, fast, runs on every CI push.

Cross-browser matrix is planned under `src/__visual__/` (scaffold only; not wired yet) (Playwright). Not part of the default CI gate — needs `pnpm exec playwright install`. The matrix is a cross-product of:

- **Transport host**: DedicatedWorker, SharedWorker, ServiceWorker, top-frame, cross-domain iframe
- **Worker role**: wraps y-websocket / hosts the Y.Doc locally / persists Y.Doc to IndexedDB or OPFS
- **Topology**: window ↔ worker; top-frame ↔ cross-domain iframe; window ↔ worker ↔ cross-domain iframe; frame1 ↔ SharedWorker ↔ frame2

Each scenario is validated against a real y-websocket backend: doc changes + awareness must propagate bidirectionally between server and browser.

We deliberately do **not** preempt the known localhost / secure-context / cross-origin quirks (see below) — the test matrix is set up to surface them as real failures first, then we fix what actually breaks rather than guessing.

## Update buffers and fan-out

Two facts that shape how this Provider sends and what you can and can't optimize:

**Yjs hands you a fresh, untouched buffer per update.** `doc.on("update", (update, origin) => ...)` emits a freshly-allocated `Uint8Array`; Yjs holds no reference after emit and never writes into it again. The buffer is yours. This is true for sync sub-protocol updates and for awareness updates.

**Transfer is a single-peer trick.** This Provider uses `port.postMessage(frame, [frame.buffer])` because it talks to exactly one peer. The transfer list detaches the underlying `ArrayBuffer` — peer receives a fresh `Uint8Array` over an independent buffer, sender's view goes to `byteLength === 0`. Zero-copy is real here.

**Fan-out cannot reuse a transferred buffer.** Once peer 1 receives via transfer, peer 2 sees nothing. If you ever fan out a single Y.Doc update to N peers (multiple MessagePort Providers on one doc, BroadcastChannel, etc.), you have three options:

1. **Plain `postMessage(frame)` to each peer, no transfer list.** Each peer pays a structured-clone copy. Default and correct for small frames (awareness, incremental edits — microseconds per clone). This is what a BroadcastChannel companion would do unconditionally; BC doesn't accept transfer lists at all.
2. **Copy for first N−1, transfer to the last.** Useful when frames are large (initial state sync, paste-of-image) and the clone cost matters.
3. **`SharedArrayBuffer`.** Requires `crossOriginIsolated` (COOP/COEP everywhere), needs a ring-buffer or length-field protocol with `Atomics.wait/notify`, and SABs aren't transferable — they're shared by reference. Engineering cost is wildly out of proportion to Yjs traffic shape (bursty small updates). Not worth it outside multi-MB-per-update scenarios.

**You cannot share one `Uint8Array` reference across realms.** Structured-clone is the postMessage contract; receivers always get independent buffers. Same goes for BroadcastChannel — even when the browser fans out to N receivers internally, each receiver deserializes its own copy. There is no "by-reference" cross-realm Uint8Array outside of SAB.

The practical consequence: this package's `detachable()` helper and the transfer-list optimization are correct for 1:1 MessagePort. They become irrelevant for a future 1:N transport. A BroadcastChannel companion in this package family will be simpler on the send path, not more complex.

## Browser quirks worth knowing (2026-05 snapshot)

- **ServiceWorker as Yjs hub is structurally broken**. Chrome kills idle SWs at 30s; SW unregisters after 5min idle. Across a restart the SW script re-runs from scratch — any MessagePort it was holding is gone. Yjs sync is bursty (idle stretches between user edits), so the SW dies between bursts and its MessagePort silently dangles. Treat SW as `client.postMessage` fanout only, never as the canonical hub.
- **Chrome Android < 148 stable**: no `SharedWorker` constructor. Restored in Chrome 148 beta but stable rollout is pending — assume absent for ~6 months. Plan a Web-Locks-leader-election fallback (see `sharedworker-yjs-cohort-2026-05-09` memo).
- **`localhost` vs `127.0.0.1`**: both are treated as secure contexts in Chrome and Firefox 84+. But they are *different origins* — cross-origin iframe handshake breaks if test fixtures mix them. SharedWorker also refuses to attach across mixed secure/non-secure contexts (`SecurityError`).
- **Transfer list footgun**: `port.postMessage(frame, [frame.buffer])` detaches the sender's view (`byteLength === 0`) — never read it again. See *Update buffers and fan-out* above for the full picture, including why this optimization doesn't generalize to BroadcastChannel or multi-peer fan-out.
- **`structuredClone` on detached views**: cloning awareness state that contains views into already-transferred buffers yields empty arrays in some engines (core-js #1265). Clone awareness *before* you transfer updates.
- **iOS Safari ≤ 15.3**: no `BroadcastChannel`. If a future fallback chain ends in BC, leader election must work standalone.
- **WebKit headless in Playwright** leads shipped Safari by 3–6 months; quirks may appear in CI that real users never see.
- **bfcache restore desync**: a page restored from bfcache will resume with stale awareness already broadcast as "removed" via `pagehide`. If your app uses bfcache, listen for `pageshow` with `event.persisted === true` and re-broadcast local awareness state.
- **Cross-agent-cluster transfer**: `postMessage` across agent clusters (cross-origin iframe with different COOP/COEP, or cross-site iframe in Chrome 106+) forces a structured-clone *copy* of the transfer list rather than a true zero-copy transfer. "Always transfers" above is true within a single agent cluster; cross-cluster pays the copy.

## Progressive enhancement worth probing (not v1)

For future work above this transport — out of scope for this package, but informs callers:

- **Web Locks** — Baseline since March 2022. Use `navigator.locks.request(name, opts, fn)` for leader election when SharedWorker is unavailable or evicted.
- **OPFS + `FileSystemSyncAccessHandle` + `FileSystemFileHandle.move()`** — atomic snapshot persistence (`write → move("doc.tmp", "doc")`). Worker-only, cross-engine since Safari 26 / Chrome 102 / FF 111. Replaces y-indexeddb's multi-writer footgun.
- **ReadableStream over MessagePort** — transferable streams give real backpressure on initial sync2. Native, not a polyfill.
- **`scheduler.postTask`** — Chrome / Firefox 142+ / no Safari. Use with `queueMicrotask` fallback for prioritizing inbound `user-blocking` sync vs background outbound flushes.
- **`crossOriginIsolated` + SAB** — only useful if the host page sets COOP/COEP. Probe and telemetry-log; do not require.

## License

[MIT](./LICENSE.md).
