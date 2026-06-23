/**
 * Wire framing for y-messageport — outer envelope only. Pure module: zero
 * Y.Doc imports, zero MessagePort imports, zero awareness imports. The frame
 * is purely bytes-in / bytes-out, so it can be unit-tested without Yjs and
 * reused if the transport ever moves off MessagePort (BroadcastChannel,
 * WebTransport datagram, etc.).
 *
 * Frame layout:
 *   [ messageType:  varUint    ]
 *   [ payload:      bytes...   ]   // body interpretation per messageType
 *
 * Message types (outer):
 *   1  messageReady       — handshake ping. Empty payload. Sent on construction;
 *                           receiving the peer's messageReady means it is alive
 *                           and listening on this port.
 *   2  messageSync        — payload is a y-protocols sync sub-message
 *                           (syncStep1 / syncStep2 / update).
 *   3  messageAwareness   — payload is a y-protocols awareness update.
 *   4  messageQueryAware. — request peer's full awareness state. Empty payload.
 *                           Sent after handshake so a late joiner learns peers.
 *
 * Why "1" and not "0" for ready: matches the literal handshake spec ("send 1
 * on init; receiving a message with 1 means peer is ready"). Zero is reserved
 * — never a valid outer message type — so a corrupted/empty buffer produces
 * a clean mismatch at decode time rather than a silent type collision.
 *
 * Capacity: varUint is unbounded; the four message types fit in one byte.
 * Adding new outer message types is safe — old peers will read the varUint
 * and route it to a default-ignore branch (see `decodeFrame`).
 *
 * Channel separation: this transport carries exactly one Y.Doc per port. The
 * caller's topology layer (e.g. y-control-channel) is responsible for handing
 * the right port to the right Y.Doc. Earlier versions of this package used a
 * varString prefix on the envelope to multiplex multiple Y.Docs on one port;
 * that was removed when the cohort-research synthesis showed every serious
 * realtime tool (Liveblocks, Hocuspocus, Automerge, Supabase) puts the
 * routing primitive at the room/doc API layer, not the wire — and per-doc
 * ports give a free middleman-ignorance property (proxies forward ports
 * without ever decoding bytes). See
 * `docs/package-specific/y-control-channel/y-messageport-control-channel.md`.
 *
 * Reserved type numbers (do NOT consume in this package):
 *   5  — historical reservation for a hub-layer broadcast primitive (cohort
 *        precedent: Hocuspocus `stateless`, Automerge `DocHandle.broadcast`).
 *        Superseded by the ControlChannel design which puts the primitive on
 *        a sibling port instead of as an outer type here. Kept reserved so
 *        existing v0 deployments that may have used it as an experimental
 *        slot can roll forward without a conflicting redefinition. Today,
 *        frames with type 5 decode as `unknown-type` (non-fatal).
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
export function encodeFrame(type: OuterMessageType, payload?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  if (payload !== undefined) {
    encoding.writeVarUint8Array(encoder, payload);
  }
  return encoding.toUint8Array(encoder);
}

export type DecodedFrame =
  | { kind: "match"; type: typeof messageSync | typeof messageAwareness; payload: Uint8Array }
  | { kind: "match"; type: typeof messageReady | typeof messageQueryAwareness; payload: null }
  | { kind: "unknown-type"; type: number };

/**
 * Decode a frame. Unknown outer types resolve to `unknown-type` for
 * forward-compat — a future version of this protocol can introduce new types
 * without breaking old receivers; they simply ignore frames they cannot
 * interpret.
 */
export function decodeFrame(data: Uint8Array): DecodedFrame {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  switch (type) {
    case messageSync:
    case messageAwareness:
      return { kind: "match", type, payload: decoding.readVarUint8Array(decoder) };
    case messageReady:
    case messageQueryAwareness:
      return { kind: "match", type, payload: null };
    default:
      return { kind: "unknown-type", type };
  }
}
