/**
 * Host-facing contracts. The leader, archive, and presence actors share
 * these shapes; none of them carry a product model.
 */

import type * as Y from "yjs";

import type { MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "./constants.js";

export interface PlexusSyncEnv {
  TEST_MODE?: boolean;
}

/**
 * Wire + persist metadata only. The leader spawns the `Y.Doc`; never pass one.
 */
export interface LaneDescriptor {
  id: string;
  messageType: typeof MESSAGE_SYNC | typeof MESSAGE_COMMENTS_SYNC | number;
  persistKey: string;
  /** `false` for archive replicas (retain tombstones). Live lanes default `true`. */
  gc?: boolean;
  broadcastFilter?: (ws: WebSocket) => boolean;
  /** Drop the frame before decode. */
  allowInbound?: (ws: WebSocket) => boolean;
}

export interface ResolvedLane extends LaneDescriptor {
  doc: Y.Doc;
}

export interface PersistPolicy {
  /** Trailing-edge coalesce for typing bursts. */
  debounceMs: number;
  /** RPO cap during continuous editing. */
  ceilingMs?: number;
}

/** Inline R2 spill from the leader alarm. The archive DO owns cold duty when present. */
export interface SpillPolicy {
  bucket: R2Bucket;
  objectKey: (entityId: string, day: string) => string;
}

/** Midnight UTC, once. R2 has no object versioning — the date is the version. */
export interface ArchiveSpillPolicy extends SpillPolicy {
  schedule: "midnight-utc-once";
}

/** Content-blind RPC. Each apply returns the follower's new state vector. */
export interface ArchiveFollowerStub {
  seed(initialState: Uint8Array): Promise<Uint8Array>;
  /** In-process sync; a Promise across a DO RPC. The leader awaits either. */
  applyDiff(diff: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Hibernatable socket state. Durable Object attachments are a 2 KiB class. */
export type WebSocketAttachment = Record<string, unknown>;

/** Host injects encode/apply/onChange. This package does not construct awareness. */
export interface AwarenessPlane {
  applyUpdate(payload: Uint8Array, origin: unknown): void;
  encodeUpdate(clientIds: number[]): Uint8Array;
  onChange(
    handler: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void,
  ): void;
}

/** Fire-and-forget projection into a sibling presence DO. */
export interface PresenceProjector {
  onAwarenessDelta(changes: { added: number[]; updated: number[] }, ctx: PresenceContext): void;
  onSocketClose(userId: string, ctx: PresenceContext): void;
}

export interface PresenceContext {
  entityId: string;
  env: unknown;
  storage: DurableObjectStorage;
}
