/**
 * Worker-side sync CLIENT — mirrors a `PlexusLeaderSyncDO`-shaped room (any
 * Durable Object speaking the leader's `/ws` upgrade + y-websocket protocol)
 * into a local `Y.Doc`. This is the DO-to-DO counterpart of a browser's
 * `WebsocketProvider`: a server-side actor (a runner DO evaluating live code,
 * a background job) that needs its own live, writable replica of a room
 * rather than a browser tab.
 *
 * Reuses this package's canonical {@link handleYjsFrame}/{@link encodeSyncStep1}/
 * {@link encodeDocUpdate} codec — NOT a duplicate protocol implementation — by
 * wrapping the single `Y.Doc` in a minimal one-lane {@link ResolvedLane} /
 * `ProtocolRouting`, the same shape `PlexusLeaderSyncDO` itself routes frames
 * through (see `../__tests__/protocol.test.ts` for the same construction).
 *
 * Chunk-safe: the raw internal WebSocket is wrapped in `ChunkedWebSocket`
 * (server-wrap mode) so an update spanning >1 MiB survives the same framing
 * `PlexusLeaderSyncDO`'s own `ChunkedDOTransport` speaks on the other end. A
 * bare (unwrapped) mirror would see orphan binary chunks, or the `y-pk-reset`
 * text sentinel, land as raw application frames.
 */

import { ChunkedWebSocket, type RawWebSocketLike } from "@here.build/chunked-websocket/client";
import * as Y from "yjs";

import { MESSAGE_SYNC } from "./constants.js";
import { encodeDocUpdate, encodeSyncStep1, handleYjsFrame, type ProtocolRouting } from "./protocol.js";
import type { ResolvedLane } from "./types.js";

/**
 * The minimal shape {@link mirrorSyncDoc} needs from its target — normally a
 * `DurableObjectStub` (e.g. `env.SOME_SYNC.get(id)`), but any fetch-shaped RPC
 * target (a test mock, a differently-hosted stub) satisfies it.
 */
export interface SyncStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface MirrorSyncDocOptions {
  /** The `?project=` query VALUE on the internal `/ws` upgrade request — whatever
   *  identifier the target's `authorizeWebSocket` expects (URL-encoded for you). */
  projectQuery: string;
  /** Lane message type this mirror speaks on (default: the prime lane, `MESSAGE_SYNC`). */
  messageType?: number;
  /** Mirror into an existing doc (e.g. one the caller already booted from a
   *  snapshot) instead of minting a fresh one. */
  doc?: Y.Doc;
  /** Deadline for `resume()`'s confirmation round-trip, in ms (default 5000). */
  confirmDeadlineMs?: number;
}

/**
 * A live mirror of one room: the (chunk-wrapped) WS to its leader DO plus a
 * sync GATE. While paused, local doc updates are buffered instead of pushed;
 * `resume` flushes the buffer and awaits the leader's confirmation via a
 * syncStep1 round-trip. WebSocket delivery is ordered, so when the reply to
 * that syncStep1 arrives the leader has already processed the buffered
 * updates sent before it — i.e. `resume()` resolving means the burst is
 * DURABLY synced, not merely applied to this replica.
 */
export interface SyncMirror {
  /** The live mirrored document. Mutate it directly — local edits are picked up
   *  by the update listener wired here and pushed out over the wire (buffered
   *  while paused). */
  readonly doc: Y.Doc;
  /** Buffer local doc updates instead of pushing them — for an atomic local
   *  burst that should land as one round-trip on `resume()`. */
  pause(): void;
  /** Flush the paused-update buffer as one send, then await a syncStep1
   *  round-trip so the caller's success means DURABLY synced, not merely
   *  applied to this replica. */
  resume(): Promise<void>;
  /** Close the underlying connection. */
  close(): void;
  /**
   * The raw internal WebSocket. Exposed ONLY so a caller can hold an explicit
   * strong reference across an `await` boundary — without one, the WebSocket
   * object can become unreachable and the peer sees a disconnect (an
   * empirically-hit Workers GC gotcha; see the field this backs in
   * `InhumanRunnerDO`'s `mirrorWs`). Prefer `doc`/`pause`/`resume`/`close` for
   * actual interaction.
   */
  readonly ws: WebSocket;
}

const DEFAULT_CONFIRM_DEADLINE_MS = 5000;

/** Reject if `work` doesn't settle within `ms`. */
async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`mirrorSyncDoc: resume() confirmation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Open an internal WS to `syncStub` and mirror it into a `Y.Doc` via the
 * y-websocket sync protocol, wrapped in `ChunkedWebSocket` (server-wrap mode)
 * so >1 MiB updates survive the same framing the leader's own
 * `ChunkedDOTransport` speaks. Returns once the initial `syncStep1` handshake
 * has been SENT (not necessarily answered) — same fire-and-forget timing as
 * the mirror this replaces; a caller that needs the doc populated before
 * proceeding gives the round-trip a brief settle window itself.
 */
export async function mirrorSyncDoc(syncStub: SyncStubLike, opts: MirrorSyncDocOptions): Promise<SyncMirror> {
  const messageType = opts.messageType ?? MESSAGE_SYNC;
  const doc = opts.doc ?? new Y.Doc();
  const confirmDeadlineMs = opts.confirmDeadlineMs ?? DEFAULT_CONFIRM_DEADLINE_MS;

  const upgrade = await syncStub.fetch(
    new Request(`https://internal/ws?project=${encodeURIComponent(opts.projectQuery)}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  const ws = upgrade.webSocket;
  if (!ws) throw new Error(`mirrorSyncDoc: stub did not return a WebSocket (project=${opts.projectQuery})`);
  // Without this, workerd delivers binary frames as Blob; new Uint8Array(blob)
  // produces a 0-length view and lib0 throws "Unexpected end of array". Cast:
  // @cloudflare/workers-types' WebSocket omits binaryType from its public
  // surface but workerd's runtime accepts the assignment.
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  ws.accept();

  // Server-wrap the raw internal WS in the chunked transport (this package's
  // leader DOs speak it via ChunkedDOTransport on the other end) — reassembles
  // any >1 MiB update split across frames, and transparently tolerates the
  // `y-pk-reset` / batch-marker text sentinels (they never reach the `message`
  // listener below; only fully-reassembled application frames do).
  const chunked = new ChunkedWebSocket(ws as RawWebSocketLike);
  ws.addEventListener("message", (ev: MessageEvent) => {
    chunked.feed(ev.data as ArrayBufferLike | string);
  });

  // One lane, this package's canonical routing shape — reuses the SAME
  // handleYjsFrame/encodeSyncStep1/encodeDocUpdate codec PlexusLeaderSyncDO
  // routes through, not a duplicate protocol implementation. `persistKey` is
  // inert here (only the leader's persistence layer ever reads it).
  const prime: ResolvedLane = { id: "prime", messageType, persistKey: "", doc };
  const routing: ProtocolRouting = { prime };

  let paused = false;
  const buffer: Uint8Array[] = [];
  // One-shot, armed by `resume()`'s round-trip: the next frame from the peer
  // confirms it processed everything sent before the syncStep1 (ordered delivery).
  let confirm: (() => void) | undefined;

  chunked.addEventListener("message", (ev) => {
    const bytes = new Uint8Array(ev.data);
    const reply = handleYjsFrame(bytes, routing, ws);
    if (reply) chunked.send(reply);
    if (confirm) {
      const done = confirm;
      confirm = undefined;
      done();
    }
  });

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return; // echo of a frame we just applied — don't re-send it
    if (paused) {
      buffer.push(update); // offline burst — flushed by resume()
      return;
    }
    chunked.send(encodeDocUpdate(update, messageType));
  });

  chunked.send(encodeSyncStep1(doc, messageType));

  return {
    doc,
    ws,
    pause() {
      paused = true;
    },
    async resume() {
      paused = false;
      for (const update of buffer.splice(0)) chunked.send(encodeDocUpdate(update, messageType));
      // Round-trip: send our state vector, await the peer's reply (bounded — a
      // wedged peer must not hang the caller). Ordered delivery makes the
      // reply a durable-receipt confirmation.
      await withDeadline(
        confirmDeadlineMs,
        () =>
          new Promise<void>((resolve) => {
            confirm = resolve;
            chunked.send(encodeSyncStep1(doc, messageType));
          }),
      );
    },
    close() {
      chunked.close();
    },
  };
}
