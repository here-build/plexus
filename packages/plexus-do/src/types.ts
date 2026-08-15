/**
 * Type contracts for Plexus sync Durable Objects.
 *
 * Product-agnostic shapes the substrate needs to broker Yjs over WebSocket,
 * persist lanes, push to archive followers, and optionally project awareness
 * into ephemeral presence DOs.
 */

import type * as Y from "yjs";

import type { MESSAGE_AWARENESS, MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "./constants.js";

/** Env fields the substrate reads directly (alarms, test gating). */
export interface PlexusSyncEnv {
  TEST_MODE?: boolean;
}

/**
 * Lane declaration — wire routing + persist key only.
 *
 * Products declare `protected readonly lanes = [...]`. The leader base spawns
 * a `Y.Doc` per descriptor; never pass `doc` here.
 */
export interface LaneDescriptor {
  id: string;
  messageType: typeof MESSAGE_SYNC | typeof MESSAGE_COMMENTS_SYNC | number;
  persistKey: string;
  /** Archive followers use `false`; live lanes default `true`. */
  gc?: boolean;
  /** Outbound gate — here.build comments uses `commentsAllowed` on the attachment. */
  broadcastFilter?: (ws: WebSocket) => boolean;
  /** Inbound gate — drop frames before decode when false. */
  allowInbound?: (ws: WebSocket) => boolean;
}

/** Descriptor + spawned doc — internal to {@link PlexusLeaderSyncDO}. */
export interface ResolvedLane extends LaneDescriptor {
  doc: Y.Doc;
}

/**
 * Write-driven persist cadence for leader DOs.
 *
 * Debounce coalesces typing bursts; optional ceiling bounds RPO during
 * continuous editing. The scheduler's dirty/persisted version counters
 * ensure edits arriving mid-persist are never lost to an alarm race.
 */
export interface PersistPolicy {
  debounceMs: number;
  ceilingMs?: number;
}

/** Inline R2 spill from the leader alarm. Archive DO owns cold-storage duty when configured. */
export interface SpillPolicy {
  bucket: R2Bucket;
  objectKey: (entityId: string, day: string) => string;
}

/** Archive DO midnight spill — one-shot alarm, date-in-key (R2 has no object versioning). */
export interface ArchiveSpillPolicy extends SpillPolicy {
  schedule: "midnight-utc-once";
}

/**
 * Content-blind RPC surface of {@link PlexusArchiveSyncDO}.
 * Leader pushes diffs; follower returns its state vector after each apply.
 */
export interface ArchiveFollowerStub {
  seed(initialState: Uint8Array): Promise<Uint8Array>;
  // Sync in-process; a Promise across a DO RPC boundary. The leader awaits either.
  applyDiff(diff: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Serialized on each accepted WebSocket via `serializeAttachment`. */
export type WebSocketAttachment = Record<string, unknown>;

/**
 * Awareness adapter — keeps this package off `@here.build/plexus`.
 * Products wire `PlexusAwareness` (encode/apply/decode) here.
 */
export interface AwarenessPlane {
  applyUpdate(payload: Uint8Array, origin: unknown): void;
  encodeUpdate(clientIds: number[]): Uint8Array;
  onChange(
    handler: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void,
  ): void;
}

/**
 * Fire-and-forget presence projection into sibling DOs.
 * Hosts may wire presence/user DOs; optional until a consumer needs them.
 */
export interface PresenceProjector {
  onAwarenessDelta(changes: { added: number[]; updated: number[] }, ctx: PresenceContext): void;
  onSocketClose(userId: string, ctx: PresenceContext): void;
}

export interface PresenceContext {
  entityId: string;
  env: unknown;
  storage: DurableObjectStorage;
}