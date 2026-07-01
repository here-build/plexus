/**
 * Invariant surface for `@here.build/hono-plexus-do`.
 *
 * Installs global `Error.invariant` via side-effect import. Substrate errors are
 * thrown through receiver-scoped `.invariant` so catch sites keep the failure
 * class (`PlexusSyncConfigError.invariant` → `PlexusSyncConfigError`).
 *
 * Programming/precondition violations → invariant throw at the call site.
 * Operational failures (persist/spill/follower I/O) → console.error + continue.
 */

import "@here.build/error-invariant";

import type { LaneDescriptor } from "./types.js";

// ── Error types ──────────────────────────────────────────────────────────────

/** Declarative lane wiring broke a substrate contract (construct time). */
export class PlexusSyncConfigError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "PlexusSyncConfigError";
  }
}

/** Runtime lookup of an unknown lane id. */
export class UnknownLaneError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "UnknownLaneError";
  }
}

// ── Lane descriptors ─────────────────────────────────────────────────────────

/**
 * Prime lane is `lanes[0]` with `id === "prime"`; routing and follower push
 * depend on that convention. Duplicate wire types or persist keys would silently
 * mis-route frames or overwrite storage.
 */
export function validateLaneDescriptors(lanes: readonly LaneDescriptor[]): void {
  // @ts-expect-error PlexusSyncConfigError is a valid Error.invariant receiver at runtime
  PlexusSyncConfigError.invariant(lanes.length > 0, "lanes must contain at least one entry");
  // @ts-expect-error PlexusSyncConfigError is a valid Error.invariant receiver at runtime
  PlexusSyncConfigError.invariant(
    lanes[0]!.id === "prime",
    () => `lanes[0] must be the prime lane (id "prime"), got "${lanes[0]!.id}"`,
  );

  const messageTypes = new Set<number>();
  const persistKeys = new Set<string>();
  const ids = new Set<string>();

  for (const lane of lanes) {
    // @ts-expect-error PlexusSyncConfigError is a valid Error.invariant receiver at runtime
    PlexusSyncConfigError.invariant(!ids.has(lane.id), () => `duplicate lane id "${lane.id}"`);
    ids.add(lane.id);

    // @ts-expect-error PlexusSyncConfigError is a valid Error.invariant receiver at runtime
    PlexusSyncConfigError.invariant(
      !messageTypes.has(lane.messageType),
      () => `duplicate messageType ${lane.messageType} on lane "${lane.id}"`,
    );
    messageTypes.add(lane.messageType);

    // @ts-expect-error PlexusSyncConfigError is a valid Error.invariant receiver at runtime
    PlexusSyncConfigError.invariant(
      !persistKeys.has(lane.persistKey),
      () => `duplicate persistKey "${lane.persistKey}" on lane "${lane.id}"`,
    );
    persistKeys.add(lane.persistKey);
  }
}

// ── Follower horizon ─────────────────────────────────────────────────────────

/** True when the follower's SV regressed — forces a full resync on the next push. */
export function regressFollowerSv(previous: Uint8Array, next: Uint8Array): boolean {
  return next.byteLength < previous.byteLength;
}