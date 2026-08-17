/**
 * The intended surface. Everything reachable from here is meant to be used.
 *
 * NAMED LISTS ONLY — no `export *`. Classes live on their specifiers
 * (`./leader`, `./archive`, `./presence`, `./client`). This entry is the
 * types, wire constants, and errors a host names when subclassing.
 *
 * `persist` / `protocol` / `follower` / `spill` are internals. So are
 * storage keys, Yjs origins, `ResolvedLane`, and `validateLaneDescriptors`.
 */

export { MESSAGE_AWARENESS, MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "./constants.js";

export type {
  ArchiveFollowerStub,
  ArchiveSpillPolicy,
  AwarenessPlane,
  LaneDescriptor,
  PersistPolicy,
  PlexusSyncEnv,
  PresenceContext,
  PresenceProjector,
  SpillPolicy,
  WebSocketAttachment,
} from "./types.js";

export { PlexusSyncConfigError, UnknownLaneError } from "./errors.js";
