/**
 * y-websocket framing: leading varuint message type, then per-lane sync
 * steps or an awareness payload.
 *
 * Inbound frames are fully reassembled (ChunkedDOTransport boundary).
 * Awareness is injected via {@link AwarenessPlane}.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "./constants.js";
import type { AwarenessPlane, ResolvedLane } from "./types.js";

export interface ProtocolRouting {
  prime: ResolvedLane;
  extraLanes?: ResolvedLane[];
  awareness?: AwarenessPlane;
}

export interface HandleFrameOptions {
  readOnly?: boolean;
  /** Drop the frame before decode. */
  allowMessageType?: (messageType: number, ws: WebSocket) => boolean;
}

// ── Inbound routing ──────────────────────────────────────────────────────────

function laneByMessageType(routing: ProtocolRouting, messageType: number): ResolvedLane | undefined {
  if (messageType === routing.prime.messageType) return routing.prime;
  return routing.extraLanes?.find((lane) => lane.messageType === messageType);
}

function handleSyncMessage(
  decoder: decoding.Decoder,
  encoder: encoding.Encoder,
  doc: Y.Doc,
  origin: unknown,
  readOnly: boolean,
): void {
  const syncMessageType = decoding.readVarUint(decoder);
  switch (syncMessageType) {
    case syncProtocol.messageYjsSyncStep1:
      syncProtocol.readSyncStep1(decoder, encoder, doc);
      break;
    case syncProtocol.messageYjsSyncStep2:
      if (!readOnly) syncProtocol.readSyncStep2(decoder, doc, origin);
      break;
    case syncProtocol.messageYjsUpdate:
      if (!readOnly) syncProtocol.readUpdate(decoder, doc, origin);
      break;
    default:
      console.warn("[plexus-do] unknown sync message type:", syncMessageType);
  }
}

/** Reply only for sync step1 → step2. Awareness returns null. */
export function handleYjsFrame(
  message: Uint8Array,
  routing: ProtocolRouting,
  origin: unknown,
  ws?: WebSocket,
  opts: HandleFrameOptions = {},
): Uint8Array | null {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);

  if (opts.allowMessageType && ws && !opts.allowMessageType(messageType, ws)) {
    return null;
  }

  if (messageType === MESSAGE_AWARENESS) {
    routing.awareness?.applyUpdate(decoding.readVarUint8Array(decoder), origin);
    return null;
  }

  const lane = laneByMessageType(routing, messageType);
  if (!lane) {
    console.warn("[plexus-do] unknown message type:", messageType);
    return null;
  }

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, lane.messageType);
  handleSyncMessage(decoder, encoder, lane.doc, origin, opts.readOnly ?? false);
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

// ── Outbound encoders ────────────────────────────────────────────────────────

export function encodeSyncStep1(doc: Y.Doc, messageType: number = MESSAGE_SYNC): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function encodeDocUpdate(update: Uint8Array, messageType: number = MESSAGE_SYNC): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
