/**
 * Process-local creation-order identity for Plexus entities.
 *
 * One GLOBAL monotonic counter; every entity mints its `localID` eagerly at
 * construction (see the PlexusModel constructor) — never lazily, because
 * first-access order is fragile where creation order is deterministic.
 *
 * Kinship: this deliberately mirrors the `ordinal.id` protocol in
 * `@here.build/collections ordinal/` — the same idea of a
 * process-local identity that is never serialized and crosses no process
 * boundary. It intentionally does NOT reuse ordinal's counter instance:
 * `resetLocalIDs()` exists as a test hook, and resetting the shared ordinal
 * counter could corrupt live path-map set-key canonicalization elsewhere in
 * the process. Separate counter domains make that corruption impossible.
 *
 * Guarantees:
 * - Never serialized: `localID` appears in no `toJSON()` output, no yjs wire
 *   state, no CRDT document. It is identity for THIS process only.
 * - Doc-less (ephemeral) entities have a `localID` by construction — unlike
 *   `.uuid`, which exists only after materialization.
 *
 * Reset contract: `resetLocalIDs()` is a TEST HOOK — reset only between
 * tests. Resetting while entities from the old epoch are still alive makes
 * localID collisions possible (an old entity and a new one can share an id).
 * The first id minted after a reset (and at process start) is 1.
 */

let nextLocalID = 1;

/** Mint the next creation-order id. Called once per entity, at construction. */
export function mintLocalID(): number {
  return nextLocalID++;
}

/** Restart the counter at 1 — test hook; see the reset contract above. */
export function resetLocalIDs(): void {
  nextLocalID = 1;
}
