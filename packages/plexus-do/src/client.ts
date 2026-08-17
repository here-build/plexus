/**
 * Worker-side mirror of a leader room into a local `Y.Doc`.
 *
 * The Durable-Object counterpart of a browser `WebsocketProvider`: a runner
 * or job that needs a live, writable replica, not a tab.
 *
 * Speaks this package's y-websocket codec through one prime lane — not a
 * second protocol. The raw internal socket is wrapped in `ChunkedWebSocket`
 * so it survives the same >1 MiB framing `ChunkedDOTransport` uses on the
 * leader. An unwrapped socket would treat orphan chunks and the
 * `y-pk-reset` text sentinel as application frames.
 */

import { ChunkedWebSocket, type RawWebSocketLike } from "@here.build/chunked-websocket/client";
import * as Y from "yjs";

import { MESSAGE_SYNC } from "./constants.js";
import { encodeDocUpdate, encodeSyncStep1, handleYjsFrame, type ProtocolRouting } from "./protocol.js";
import type { ResolvedLane } from "./types.js";

/** Anything `fetch`-shaped — usually a `DurableObjectStub`. */
export interface SyncStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface MirrorSyncDocOptions {
  /** `?project=` value on the internal `/ws` upgrade. URL-encoded here. */
  projectQuery: string;
  messageType?: number;
  doc?: Y.Doc;
  confirmDeadlineMs?: number;
}

/**
 * Live replica plus a sync gate. `pause` buffers local updates; `resume`
 * flushes them and waits for the leader's syncStep1 reply. WebSocket
 * delivery is ordered, so that reply means the burst is durable on the
 * leader — not merely applied to this replica.
 */
export interface SyncMirror {
  readonly doc: Y.Doc;
  pause(): void;
  resume(): Promise<void>;
  close(): void;
  /**
   * Strong-ref hook. Workerd can GC an unreferenced WebSocket across an
   * `await`; the peer then sees a disconnect. Hold this if you await
   * between `mirrorSyncDoc` and `close`.
   */
  readonly ws: WebSocket;
}

const DEFAULT_CONFIRM_DEADLINE_MS = 5000;

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
 * Returns once the opening syncStep1 has been sent, not answered.
 * A caller that needs the doc populated waits itself.
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

  const chunked = new ChunkedWebSocket(ws as RawWebSocketLike);
  ws.addEventListener("message", (ev: MessageEvent) => {
    chunked.feed(ev.data as ArrayBufferLike | string);
  });

  const prime: ResolvedLane = { id: "prime", messageType, persistKey: "", doc };
  const routing: ProtocolRouting = { prime };

  let paused = false;
  const buffer: Uint8Array[] = [];
  let resolveResumeConfirmation: (() => void) | undefined;

  chunked.addEventListener("message", (ev) => {
    const bytes = new Uint8Array(ev.data);
    const reply = handleYjsFrame(bytes, routing, ws);
    if (reply) chunked.send(reply);
    if (resolveResumeConfirmation) {
      const done = resolveResumeConfirmation;
      resolveResumeConfirmation = undefined;
      done();
    }
  });

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return;
    if (paused) {
      buffer.push(update);
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
      await withDeadline(
        confirmDeadlineMs,
        () =>
          new Promise<void>((resolve) => {
            resolveResumeConfirmation = resolve;
            chunked.send(encodeSyncStep1(doc, messageType));
          }),
      );
    },
    close() {
      chunked.close();
    },
  };
}
