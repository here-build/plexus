import "./errors.js";

export {
  ENTITY_ID_STORAGE_KEY,
  GENESIS_ORIGIN,
  MESSAGE_AWARENESS,
  MESSAGE_COMMENTS_SYNC,
  MESSAGE_SYNC,
  REHYDRATE_ORIGIN,
} from "./constants.js";

export type {
  ArchiveFollowerStub,
  ArchiveSpillPolicy,
  AwarenessPlane,
  LaneDescriptor,
  PersistPolicy,
  PlexusSyncEnv,
  PresenceContext,
  PresenceProjector,
  ResolvedLane,
  SpillPolicy,
  WebSocketAttachment,
} from "./types.js";

export {
  encodeDiffSince,
  encodeDocUpdate,
  encodeFullState,
  encodeStateVector,
  encodeSyncStep1,
  handleYjsFrame,
  type HandleFrameOptions,
  type ProtocolRouting,
} from "./protocol.js";

export {
  PersistScheduler,
  applyRehydrate,
  persistLaneSnapshot,
  shouldIgnoreUpdateOrigin,
  type PersistLaneState,
  type PersistSchedulerHooks,
} from "./persist.js";

export { PlexusSyncConfigError, UnknownLaneError, validateLaneDescriptors } from "./errors.js";
export { pushDiffToFollower, regressFollowerSv, seedFollower } from "./follower.js";
export { ensureMidnightSpillAlarm, nextMidnightUtc, spillDocToR2, utcDayKey } from "./spill.js";
export { mountDocHost } from "./hono/host.js";

export { PlexusArchiveSyncDO } from "./archive-sync-do.js";
export { PlexusLeaderSyncDO, type WebSocketHandshakeResult } from "./leader-sync-do.js";
export { EphemeralRegistryDO } from "./presence/ephemeral-registry.js";