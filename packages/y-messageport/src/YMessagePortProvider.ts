/**
 * YMessagePortProvider — symmetric Yjs sync + awareness over a MessagePort.
 *
 * Wire shape lives in `./protocol.ts` (outer envelope) and `y-protocols` (inner
 * sync + awareness sub-protocols). Either side may construct first; on
 * construction each posts `messageReady`, and on receiving the peer's
 * `messageReady` each fires syncStep1 + queryAwareness + own awareness state.
 *
 * One Y.Doc per port. Caller's topology layer (e.g. y-control-channel) is
 * responsible for handing the right port to the right Y.Doc — typically via
 * a per-doc MessageChannel transferred over a ControlChannel.
 *
 * Lifetime: the Provider owns nothing it didn't allocate. Not the Y.Doc, not
 * the MessagePort (caller created and closes it), and the Awareness only when
 * one wasn't supplied via options.
 *
 * Listener model: `addEventListener("message", ...)` rather than
 * `port.onmessage = ...`. The setter is single-slot; `addEventListener`
 * composes with caller-attached listeners but requires explicit `port.start()`.
 */

import { Observable } from "lib0/observable";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  messageYjsSyncStep2,
  readSyncMessage,
  writeSyncStep1,
  writeUpdate,
} from "y-protocols/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import {
  type OuterMessageType,
  decodeFrame,
  encodeFrame,
  messageAwareness,
  messageQueryAwareness,
  messageReady,
  messageSync,
} from "./protocol.js";

export interface YMessagePortProviderOptions {
  /** Externally-owned Awareness to reuse. If omitted, Provider creates+owns one. */
  awareness?: Awareness;
  /**
   * Milliseconds to wait for peer's first sync reply before emitting
   * `sync-timeout` status. The Provider does NOT tear down — peer may still
   * arrive late. Default 10_000. Pass `0` to disable.
   */
  syncTimeoutMs?: number;
}

export type Status = "connecting" | "connected" | "disconnected" | "sync-timeout";

/**
 * `error` event payloads carry a second-arg kind tag. Consumers switch on it
 * to distinguish frame-decode failure from inner-protocol failure (so they
 * can, e.g., log decode errors at WARN but escalate sync errors).
 *
 * - `decode`            — outer envelope failed to parse (lib0 throw).
 * - `sync`              — y-protocols/sync threw on an inner payload.
 * - `awareness`         — y-protocols/awareness threw on an inner payload.
 * - `messageerror`      — MessagePort `messageerror` event (structured-clone
 *                         failed on receive — typically SAB across non-isolated
 *                         agent clusters).
 * - `unknown-type`      — peer sent an outer type this version doesn't know
 *                         (forward-compat). Non-fatal — frame is ignored.
 * - `wrong-payload-shape` — receive event whose `data` was not a Uint8Array.
 */
export type YMessagePortErrorKind =
  | "decode"
  | "sync"
  | "awareness"
  | "messageerror"
  | "unknown-type"
  | "wrong-payload-shape";

/**
 * Typed event-payload map. `Observable<Events>`'s emit signature is untyped
 * upstream; we export this so consumers can wrap with a typed emitter.
 *
 *   provider.on("error", (...args) => {
 *     const [err, kind] = args as YMessagePortEvents["error"];
 *   });
 */
export interface YMessagePortEvents {
  sync: [synced: boolean];
  status: [{ status: Status }];
  error: [error: unknown, kind: YMessagePortErrorKind];
}

type Events = keyof YMessagePortEvents;

/**
 * Origin tag for transactions we apply from peer updates. Exported so consumers
 * can filter their own emit loop:
 *
 *   doc.on("update", (update, origin) => {
 *     if (origin === YMessagePortProviderOrigin) return; // came from peer
 *     // ...local-only handling
 *   });
 */
export const YMessagePortProviderOrigin: unique symbol = Symbol("y-messageport");
const TRANSACTION_ORIGIN = YMessagePortProviderOrigin;

/**
 * Detached-buffer guard for transfer list. `encoding.toUint8Array()` may
 * return a view into a larger lib0 backing buffer; transferring `.buffer`
 * would detach unrelated bytes. Copy first so the transfer is sound.
 */
function detachable(frame: Uint8Array): Uint8Array {
  if (frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength) {
    return frame;
  }
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  return copy;
}

export class YMessagePortProvider extends Observable<Events> {
  readonly doc: Y.Doc;
  readonly port: MessagePort;
  readonly awareness: Awareness;

  private _synced = false;
  private _status: Status = "connecting";
  private readonly _ownsAwareness: boolean;
  private readonly _onMessage: (ev: MessageEvent<unknown>) => void;
  private readonly _onMessageError: (ev: MessageEvent<unknown>) => void;
  private readonly _onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly _onAwarenessUpdate: (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => void;
  private readonly _onPageHide: () => void;
  private readonly _hasWindow: boolean;
  private _syncTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _destroyed = false;

  constructor(doc: Y.Doc, port: MessagePort, options: YMessagePortProviderOptions = {}) {
    super();
    this.doc = doc;
    this.port = port;
    this.awareness = options.awareness ?? new Awareness(doc);
    this._ownsAwareness = options.awareness === undefined;

    this._onMessage = (ev) => {
      if (!(ev.data instanceof Uint8Array)) {
        this.emit("error", [new TypeError("expected Uint8Array frame"), "wrong-payload-shape"]);
        return;
      }
      this._handleMessage(ev.data);
    };
    this._onMessageError = (ev) => {
      this.emit("error", [ev, "messageerror"]);
    };
    this._onDocUpdate = (update, origin) => {
      if (origin === TRANSACTION_ORIGIN) return;
      const inner = encoding.createEncoder();
      writeUpdate(inner, update);
      this._send(messageSync, encoding.toUint8Array(inner));
    };
    this._onAwarenessUpdate = ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed);
      this._send(messageAwareness, encodeAwarenessUpdate(this.awareness, changed));
    };
    this._onPageHide = () => {
      removeAwarenessStates(this.awareness, [this.doc.clientID], TRANSACTION_ORIGIN);
    };

    this.doc.on("update", this._onDocUpdate);
    this.awareness.on("update", this._onAwarenessUpdate);
    // `pagehide` instead of `beforeunload` — `beforeunload` disables bfcache
    // and doesn't exist in Worker/SharedWorker/ServiceWorker scopes. We probe
    // for `window` specifically (not just `addEventListener`, which exists on
    // workers too — but its event surface differs).
    this._hasWindow =
      typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (this._hasWindow) {
      window.addEventListener("pagehide", this._onPageHide);
    }
    this.port.addEventListener("message", this._onMessage as EventListener);
    this.port.addEventListener("messageerror", this._onMessageError as EventListener);
    this.port.start();

    // Peer may have posted `messageReady` before we attached — MessagePort
    // buffers between creation and `start()`. Send ours last; either order
    // resolves correctly.
    this._send(messageReady);

    const timeout = options.syncTimeoutMs ?? 10_000;
    if (timeout > 0) {
      this._syncTimeoutHandle = setTimeout(() => {
        this._syncTimeoutHandle = null;
        if (!this._synced && !this._destroyed) {
          this._setStatus("sync-timeout");
        }
      }, timeout);
    }
  }

  /** True once we have applied the peer's syncStep2 and the local replica is up-to-date. */
  get synced(): boolean {
    return this._synced;
  }

  get status(): Status {
    return this._status;
  }

  /** Idempotent teardown. Does NOT close the port (caller owns it). */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._syncTimeoutHandle !== null) {
      clearTimeout(this._syncTimeoutHandle);
      this._syncTimeoutHandle = null;
    }
    this._setStatus("disconnected");
    if (this._hasWindow) {
      window.removeEventListener("pagehide", this._onPageHide);
    }
    this.doc.off("update", this._onDocUpdate);
    this.awareness.off("update", this._onAwarenessUpdate);
    this.port.removeEventListener("message", this._onMessage as EventListener);
    this.port.removeEventListener("messageerror", this._onMessageError as EventListener);
    if (this._ownsAwareness) {
      this.awareness.destroy();
    }
    super.destroy();
  }

  private _send(type: OuterMessageType, payload?: Uint8Array): void {
    if (this._destroyed) return;
    const frame = detachable(encodeFrame(type, payload));
    this.port.postMessage(frame, [frame.buffer]);
  }

  /**
   * Send our local awareness state if non-null. Matches y-websocket's
   * post-handshake behavior — peer must learn we exist even if we don't yet
   * track anyone else.
   */
  private _broadcastLocalAwareness(): void {
    if (this.awareness.getLocalState() === null) return;
    this._send(
      messageAwareness,
      encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
  }

  /** Send every known awareness state (response to messageQueryAwareness). */
  private _broadcastFullAwareness(): void {
    if (this.awareness.getStates().size === 0) return;
    const ids = Array.from(this.awareness.getStates().keys());
    this._send(messageAwareness, encodeAwarenessUpdate(this.awareness, ids));
  }

  private _handleMessage(data: Uint8Array): void {
    if (this._destroyed) return;
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (err) {
      this.emit("error", [err, "decode"]);
      return;
    }
    if (frame.kind === "unknown-type") {
      // Forward-compat: a newer peer sent a type we don't grok. Non-fatal —
      // surface so version skew is debuggable.
      this.emit("error", [
        new Error(`unknown outer message type ${frame.type}`),
        "unknown-type",
      ]);
      return;
    }

    switch (frame.type) {
      case messageReady:
        // Re-receipt after a prior sync means the peer restarted (e.g. tab
        // reload, worker eviction + reconnect). Flip back to unsynced and
        // re-run the handshake so consumers observe the gap.
        if (this._synced) {
          this._synced = false;
          this.emit("sync", [false]);
        }
        this._sendSyncStep1();
        this._send(messageQueryAwareness);
        this._broadcastLocalAwareness();
        this._setStatus("connected");
        return;

      case messageSync: {
        // `readSyncMessage` throws on unknown sub-types (forward-compat
        // mismatch) or malformed payloads. A bad frame must not tear down
        // the channel — surface as `error` event and keep listening.
        try {
          const decoder = decoding.createDecoder(frame.payload);
          const replyEncoder = encoding.createEncoder();
          const subType = readSyncMessage(decoder, replyEncoder, this.doc, TRANSACTION_ORIGIN);
          if (encoding.length(replyEncoder) > 0) {
            this._send(messageSync, encoding.toUint8Array(replyEncoder));
          }
          // syncStep2 (or an update that follows it) means our replica is
          // caught up with the peer's state vector — flip `synced` once.
          if (subType === messageYjsSyncStep2 && !this._synced) {
            this._synced = true;
            this.emit("sync", [true]);
          }
        } catch (err) {
          this.emit("error", [err, "sync"]);
        }
        return;
      }

      case messageAwareness:
        try {
          applyAwarenessUpdate(this.awareness, frame.payload, TRANSACTION_ORIGIN);
        } catch (err) {
          this.emit("error", [err, "awareness"]);
        }
        return;

      case messageQueryAwareness:
        this._broadcastFullAwareness();
        return;
    }
  }

  private _sendSyncStep1(): void {
    const inner = encoding.createEncoder();
    writeSyncStep1(inner, this.doc);
    this._send(messageSync, encoding.toUint8Array(inner));
  }

  private _setStatus(next: Status): void {
    if (this._status === next) return;
    this._status = next;
    this.emit("status", [{ status: next }]);
  }
}
