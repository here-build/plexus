/**
 * Shared wire + origin constants for Plexus sync Durable Objects.
 *
 * Origins tag Yjs `update` events so the leader can distinguish peer writes
 * (broadcast + persist) from substrate-internal replays (rehydrate, genesis).
 * Message-type constants match the y-websocket varuint prefix convention.
 */

/** DO storage key for the late-bound project/entity id (survives hibernation). */
export const ENTITY_ID_STORAGE_KEY = "entityId";

/**
 * Storage replay on `blockConcurrencyWhile` boot. Listeners must NOT broadcast
 * or mark dirty — the bytes are already on disk and peers do not need them again.
 */
export const REHYDRATE_ORIGIN = "snapshot" as const;

/**
 * Bytes returned from {@link PlexusLeaderSyncDO.getSeedState} on first boot when
 * a lane's `persistKey` is empty. Persisted immediately; still not a peer write.
 */
export const GENESIS_ORIGIN = "genesis" as const;

/** Prime doc lane — y-websocket `MESSAGE_SYNC` (varuint 0). */
export const MESSAGE_SYNC = 0;

/** Awareness plane — y-websocket `MESSAGE_AWARENESS` (varuint 1). */
export const MESSAGE_AWARENESS = 1;

/**
 * Sibling-doc lane (here.build comments). Extends the switch without breaking
 * clients that only emit 0/1 — old clients never send this type.
 */
export const MESSAGE_COMMENTS_SYNC = 2;