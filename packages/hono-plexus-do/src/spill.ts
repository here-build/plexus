/**
 * Date-keyed R2 spill helpers.
 *
 * R2 has no object versioning, so cold storage uses `${entityId}/${YYYY-MM-DD}`
 * keys plus bucket-wide age lifecycle — the same pattern as ProjectLogDO and
 * InhumanSyncDO. Archive DOs arm a one-shot midnight UTC alarm; the leader may
 * spill inline on its own alarm when no archive follower owns cold duty.
 */

import "./errors.js";

import * as Y from "yjs";

import type { SpillPolicy } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextMidnightUtc(now: number = Date.now()): number {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
}

export async function spillDocToR2(doc: Y.Doc, entityId: string, policy: SpillPolicy): Promise<void> {
  TypeError.invariant(entityId.length > 0, "spillDocToR2: entityId must not be empty");
  const fullState = Y.encodeStateAsUpdate(doc);
  const day = utcDayKey();
  // Uint8Array is an ArrayBufferView — R2 put accepts it directly, no cast.
  await policy.bucket.put(policy.objectKey(entityId, day), fullState);
}

/**
 * Arm a one-shot midnight UTC alarm when none is pending.
 * Does NOT re-arm after fire — the next write rearms (avoids identical-date overwrites).
 */
export async function ensureMidnightSpillAlarm(
  storage: DurableObjectStorage,
  testMode: boolean,
  now: number = Date.now(),
): Promise<void> {
  if (testMode) return;
  const existing = await storage.getAlarm();
  if (existing != null) return;
  await storage.setAlarm(nextMidnightUtc(now));
}