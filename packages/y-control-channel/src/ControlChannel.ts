/**
 * ControlChannel — Yjs-agnostic port-routing primitive over a MessagePort.
 *
 * Each side constructs once with a port-end of a shared MessageChannel. On
 * construction both sides post `hello`. `open(id)` allocates a fresh
 * MessageChannel, transfers `port2` to the peer in an `open` message, and
 * returns `port1` for the caller to attach to whatever (a YMessagePortProvider,
 * a custom resource sync, anything).
 *
 * Receiver side gets the peer's `open` as an event with the freshly-arrived
 * MessagePort and the same `id`. Routing of `id → resource` is pure caller
 * policy. The control plane is intentionally dumb about resources.
 *
 * Lifecycle: explicit. `destroy()` stops heartbeat + listeners; it does NOT
 * close the underlying port (caller created it, caller closes it). `close(id)`
 * is advisory — the peer chooses whether to act on it (multi-tab scenarios
 * must NOT auto-tear-down).
 */

import { Observable } from "lib0/observable";

import {
  type ControlMessage,
  PROTOCOL_VERSION,
  isControlMessage,
} from "./protocol.js";

export interface ControlChannelOptions {
  /**
   * Milliseconds between outbound `ping` frames. Default 30_000. Set to 0 to
   * disable heartbeat entirely. Heartbeat is *insurance* — meaningful liveness
   * lives on the control channel because doc ports stay quiet between Yjs
   * bursts; if you don't care about liveness, disable it.
   */
  heartbeatMs?: number;
}

export type ErrorKind =
  | "wrong-payload-shape"
  | "duplicate-open"
  | "messageerror"
  | "peer-error";

type Events = "hello" | "open" | "close" | "status" | "ping" | "pong" | "error";

export class ControlChannel extends Observable<Events> {
  readonly port: MessagePort;

  private readonly _heartbeatMs: number;
  private readonly _onMessage: (ev: MessageEvent<unknown>) => void;
  private readonly _onMessageError: (ev: MessageEvent<unknown>) => void;
  private _heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private _lastSeenMs: number = Date.now();
  private _destroyed = false;
  private _nonce = 0;
  /** Ports we allocated and handed out via `open`. Used to detect duplicate ids. */
  private readonly _openLocal = new Set<string>();
  /** Ports we received from peer via `open`. Used to detect duplicate ids from peer. */
  private readonly _openRemote = new Set<string>();

  constructor(port: MessagePort, options: ControlChannelOptions = {}) {
    super();
    this.port = port;
    this._heartbeatMs = options.heartbeatMs ?? 30_000;

    this._onMessage = (ev) => this._handleMessage(ev);
    this._onMessageError = (ev) => {
      this.emit("error", [new Error("messageerror"), "messageerror" as ErrorKind, ev]);
    };

    this.port.addEventListener("message", this._onMessage as EventListener);
    this.port.addEventListener("messageerror", this._onMessageError as EventListener);
    this.port.start();

    this._post({ kind: "hello", proto: PROTOCOL_VERSION });

    if (this._heartbeatMs > 0) {
      this._heartbeatHandle = setInterval(() => {
        if (this._destroyed) return;
        this._post({ kind: "ping", nonce: ++this._nonce });
      }, this._heartbeatMs);
    }
  }

  /**
   * Allocate a fresh MessageChannel for resource `id`, transfer the peer end
   * across the control channel, return the local end. Caller attaches the
   * returned port to whatever (YMessagePortProvider, custom sync, etc.).
   *
   * Duplicate `id` is a caller bug: emits `error` of kind `duplicate-open`
   * and throws. (Strict because the peer is keying routing tables on `id`
   * and silent overwrite would be worse than loud failure.)
   */
  open(id: string): MessagePort {
    if (this._destroyed) {
      throw new Error("ControlChannel: open() on destroyed channel");
    }
    if (this._openLocal.has(id)) {
      const err = new Error(`ControlChannel: duplicate open id "${id}"`);
      this.emit("error", [err, "duplicate-open" as ErrorKind]);
      throw err;
    }
    this._openLocal.add(id);
    const { port1, port2 } = new MessageChannel();
    this._post({ kind: "open", id }, [port2]);
    return port1;
  }

  /**
   * Advisory close. Peer does NOT auto-tear-down — it receives a `close`
   * event with the same `id` and decides policy. Critical for multi-tab
   * scenarios where one tab releasing a doc should not yank state from
   * siblings.
   */
  close(id: string): void {
    if (this._destroyed) return;
    this._openLocal.delete(id);
    this._post({ kind: "close", id });
  }

  /**
   * Forward an upstream-hop's status to the peer. `hop` is an app-defined
   * label (e.g. "ws", "worker", "iframe"). Consumer composes UI status from
   * the set of received hop statuses — see the multi-hop status pattern in
   * the working proposal.
   */
  postStatus(hop: string, status: string): void {
    if (this._destroyed) return;
    this._post({ kind: "status", hop, status });
  }

  /** Last time any control message arrived. Consumer applies its own liveness threshold. */
  lastSeenMs(): number {
    return this._lastSeenMs;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._heartbeatHandle !== null) {
      clearInterval(this._heartbeatHandle);
      this._heartbeatHandle = null;
    }
    this.port.removeEventListener("message", this._onMessage as EventListener);
    this.port.removeEventListener("messageerror", this._onMessageError as EventListener);
    super.destroy();
  }

  private _post(msg: ControlMessage, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.port.postMessage(msg, transfer);
    } else {
      this.port.postMessage(msg);
    }
  }

  private _handleMessage(ev: MessageEvent<unknown>): void {
    if (this._destroyed) return;
    const data = ev.data;
    if (!isControlMessage(data)) {
      this.emit("error", [
        new TypeError("ControlChannel: payload is not a ControlMessage"),
        "wrong-payload-shape" as ErrorKind,
        data,
      ]);
      return;
    }
    this._lastSeenMs = Date.now();

    switch (data.kind) {
      case "hello":
        this.emit("hello", []);
        return;
      case "open": {
        if (this._openRemote.has(data.id)) {
          this.emit("error", [
            new Error(`ControlChannel: peer sent duplicate open id "${data.id}"`),
            "duplicate-open" as ErrorKind,
          ]);
          return;
        }
        const port = ev.ports[0];
        if (!port) {
          this.emit("error", [
            new Error("ControlChannel: open message arrived without a transferred port"),
            "wrong-payload-shape" as ErrorKind,
          ]);
          return;
        }
        this._openRemote.add(data.id);
        this.emit("open", [data.id, port]);
        return;
      }
      case "close":
        this._openRemote.delete(data.id);
        this.emit("close", [data.id]);
        return;
      case "ping":
        // Echo immediately. Liveness is observed by lastSeenMs on either side.
        this._post({ kind: "pong", nonce: data.nonce });
        this.emit("ping", [data.nonce]);
        return;
      case "pong":
        this.emit("pong", [data.nonce]);
        return;
      case "status":
        this.emit("status", [data.hop, data.status]);
        return;
      case "error":
        this.emit("error", [new Error(data.reason), "peer-error" as ErrorKind]);
        return;
    }
  }
}
