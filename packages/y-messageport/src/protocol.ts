/**
 * Wire framing for y-messageport — outer envelope only. Pure module: zero
 * Y.Doc imports, zero MessagePort imports, zero awareness imports. The frame
 * is purely bytes-in / bytes-out, so it can be unit-tested without Yjs and
 * reused if the transport ever moves off MessagePort (BroadcastChannel,
 * WebTransport datagram, etc.).
 *
 * Frame layout:
 *   [ prefix:       varString  ]   // "" when no multiplexing; UTF-8 otherwise
 *   [ messageType:  varUint    ]
 *   [ payload:      bytes...   ]   // body interpretation per messageType
 *
 * Message types (outer):
 *   1  messageReady       — handshake ping. Empty payload. Sent on construction;
 *                           receiving the peer's messageReady means it is alive
 *                           and listening on this prefix.
 *   2  messageSync        — payload is a y-protocols sync sub-message
 *                           (syncStep1 / syncStep2 / update).
 *   3  messageAwareness   — payload is a y-protocols awareness update.
 *   4  messageQueryAware. — request peer's full awareness state. Empty payload.
 *                           Sent after handshake so a late joiner learns peers.
 *
 * Why "1" and not "0" for ready: matches the literal handshake spec ("send 1
 * on init; receiving a message with 1 means peer is ready"). Zero is reserved
 * — never a valid outer message type — so a peer-without-prefix talking to a
 * peer-with-prefix produces a clean mismatch at decode time rather than a
 * silent type collision.
 *
 * Capacity: varUint is unbounded; the four message types fit in one byte.
 * Adding new outer message types is safe — old peers will read the varUint
 * and route it to a default-ignore branch (see `decodeFrame`).
 *
 * Reserved type numbers (do NOT consume in this package):
 *   5  — reserved for app-defined "stateless" / ephemeral broadcast at the
 *        hub layer above this transport. Cohort precedent: Hocuspocus
 *        `stateless`, Automerge `DocHandle.broadcast`, Liveblocks
 *        `broadcastEvent`. Those primitives belong one layer up (the
 *        SharedWorker / WS-multiplexing hub that owns room/doc semantics),
 *        not at the wire. y-messageport is the wire; it has prefix
 *        multiplexing but no room concept. If a future hub package wants
 *        the slot, it claims 5 — and owns its own inner discriminator,
 *        because prefix-multiplexed ports have N consumers per port and a
 *        bare opaque payload would push the dispatch burden to each one.
 *        Today, frames with type 5 decode as `unknown-type` (non-fatal).
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export const messageReady = 1;
export const messageSync = 2;
export const messageAwareness = 3;
export const messageQueryAwareness = 4;

export type OuterMessageType =
  | typeof messageReady
  | typeof messageSync
  | typeof messageAwareness
  | typeof messageQueryAwareness;

/**
 * Encode a frame for transmission. Returns a fresh Uint8Array — caller owns
 * the underlying buffer and MUST pass `.buffer` in the postMessage transfer
 * list to avoid a structured-clone copy (the perf cliff described in the
 * browser-quirks notes).
 */
export function encodeFrame(prefix: string, type: OuterMessageType, payload?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, prefix);
  encoding.writeVarUint(encoder, type);
  if (payload !== undefined) {
    encoding.writeVarUint8Array(encoder, payload);
  }
  return encoding.toUint8Array(encoder);
}

export type DecodedFrame =
  | { kind: "match"; type: typeof messageSync | typeof messageAwareness; payload: Uint8Array }
  | { kind: "match"; type: typeof messageReady | typeof messageQueryAwareness; payload: null }
  | { kind: "wrong-prefix"; prefix: string }
  | { kind: "unknown-type"; prefix: string; type: number };

/**
 * Decode a frame and route by prefix. The caller's `expectedPrefix` is the
 * one this Provider instance was constructed with; mismatching frames are
 * surfaced as `wrong-prefix` rather than thrown, so the caller can ignore
 * them silently (they belong to a sibling Provider sharing the port).
 *
 * Unknown outer types resolve to `unknown-type` for forward-compat — a future
 * version of this protocol can introduce new types without breaking old
 * receivers; they simply ignore frames they cannot interpret.
 */
export function decodeFrame(data: Uint8Array, expectedPrefix: string): DecodedFrame {
  const decoder = decoding.createDecoder(data);
  const prefix = decoding.readVarString(decoder);
  if (prefix !== expectedPrefix) {
    return { kind: "wrong-prefix", prefix };
  }
  const type = decoding.readVarUint(decoder);
  switch (type) {
    case messageSync:
    case messageAwareness:
      return { kind: "match", type, payload: decoding.readVarUint8Array(decoder) };
    case messageReady:
    case messageQueryAwareness:
      return { kind: "match", type, payload: null };
    default:
      return { kind: "unknown-type", prefix, type };
  }
}
