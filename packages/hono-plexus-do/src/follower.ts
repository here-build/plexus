/**
 * Leader → archive follower push.
 *
 * Topology: the leader is authoritative for live edits; the archive DO is a
 * content-blind `gc:false` replica fed by `applyDiff`. The leader tracks the
 * follower's last-known state vector so each push sends only missing ops.
 *
 * Self-healing: Yjs `applyUpdate` is idempotent — a stale horizon just means
 * a larger-than-needed diff on the next tick. If the follower's SV *shrinks*
 * (catastrophic storage loss), we reset the horizon to empty so the next push
 * carries the full doc.
 */

import "./errors.js";

import * as Y from "yjs";

import type { ArchiveFollowerStub } from "./types.js";

/** Encode and push everything the follower is missing; return the new horizon SV. */
export async function pushDiffToFollower(
  doc: Y.Doc,
  lastKnownSv: Uint8Array,
  stub: ArchiveFollowerStub,
): Promise<Uint8Array> {
  // Empty horizon (never seeded / post-regression reset) — full doc, not lib0 decode of 0 bytes.
  const diff =
    lastKnownSv.byteLength === 0
      ? Y.encodeStateAsUpdate(doc)
      : Y.encodeStateAsUpdate(doc, lastKnownSv);
  if (diff.length === 0) return lastKnownSv;
  const newSv = await stub.applyDiff(diff);
  return regressFollowerSv(lastKnownSv, newSv) ? new Uint8Array() : newSv;
}

/** True when the follower's SV regressed — forces a full resync on the next push. */
export function regressFollowerSv(previous: Uint8Array, next: Uint8Array): boolean {
  return next.byteLength < previous.byteLength;
}

/** First-touch seed into the archive replica (clone route / leader `seed`). */
export async function seedFollower(stub: ArchiveFollowerStub, initialState: Uint8Array): Promise<Uint8Array> {
  TypeError.invariant(initialState.byteLength > 0, "seedFollower: yjsState must not be empty");
  return stub.seed(initialState);
}