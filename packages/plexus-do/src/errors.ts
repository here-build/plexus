import "@here.build/error-invariant";

import type { LaneDescriptor } from "./types.js";

abstract class PlexusSyncError extends Error {
  name = this.constructor.name;

  protected constructor(message: string, consoleMessage: string, consoleData: object) {
    super(message);
    // some runtimes omit captureStackTrace — don't crash inside crash.
    const ErrorWithCapture = Error as typeof Error & {
      captureStackTrace?(object: object, constructor?: Function): void;
    };
    ErrorWithCapture.captureStackTrace?.(this, this.constructor);
    // Log synchronously — a deferred timer may never fire once a Workers invocation ends.
    console.error(consoleMessage, { ...consoleData, stack: this.stack });
  }

  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }
}

export class PlexusSyncConfigError extends PlexusSyncError {
  constructor(public readonly detail: string) {
    super(`PlexusSyncDO: ${detail}`, "Sync DO config error:", { detail });
  }
}

export class UnknownLaneError extends PlexusSyncError {
  constructor(public readonly laneId: string) {
    super(`PlexusSyncDO: unknown lane "${laneId}"`, "Unknown lane lookup:", { laneId });
  }
}

// ── Lane descriptor validation ───────────────────────────────────────────────

/**
 * Prime lane is `lanes[0]` with `id === "prime"`; routing and follower push
 * depend on that convention. Duplicate wire types or persist keys would silently
 * mis-route frames or overwrite storage.
 */
export function validateLaneDescriptors(lanes: readonly LaneDescriptor[]): void {
  PlexusSyncConfigError.invariant(lanes.length > 0, "lanes must contain at least one entry");
  PlexusSyncConfigError.invariant(
    lanes[0]!.id === "prime",
    `lanes[0] must be the prime lane (id "prime"), got "${lanes[0]!.id}"`,
  );

  const messageTypes = new Set<number>();
  const persistKeys = new Set<string>();
  const ids = new Set<string>();

  for (const lane of lanes) {
    PlexusSyncConfigError.invariant(!ids.has(lane.id), `duplicate lane id "${lane.id}"`);
    ids.add(lane.id);

    PlexusSyncConfigError.invariant(
      !messageTypes.has(lane.messageType),
      `duplicate messageType ${lane.messageType} on lane "${lane.id}"`,
    );
    messageTypes.add(lane.messageType);

    PlexusSyncConfigError.invariant(
      !persistKeys.has(lane.persistKey),
      `duplicate persistKey "${lane.persistKey}" on lane "${lane.id}"`,
    );
    persistKeys.add(lane.persistKey);
  }
}