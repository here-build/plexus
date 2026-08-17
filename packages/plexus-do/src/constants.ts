/**
 * Origins tag Yjs `update` events so listeners can tell a peer write
 * (broadcast + persist) from a substrate replay. Message types are the
 * y-websocket varuint prefixes.
 */

/** Late-bound project id. Survives hibernation; `ctx.id.name` does not. */
export const ENTITY_ID_STORAGE_KEY = "entityId";

/** Storage replay. Must not broadcast or mark dirty — peers already have these bytes. */
export const REHYDRATE_ORIGIN = "snapshot" as const;

/** First-boot `getSeedState` / external `seed`. Not a peer write. */
export const GENESIS_ORIGIN = "genesis" as const;

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Sibling-doc lane. Clients that only emit 0/1 never send this. */
export const MESSAGE_COMMENTS_SYNC = 2;