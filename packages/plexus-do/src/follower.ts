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

import * as Y from "yjs";

import "./errors.js";
import { encodeStateSince } from "./persist.js";
import type { ArchiveFollowerStub } from "./types.js";

export async function pushDiffToFollower(
  doc: Y.Doc,
  lastKnownSv: Uint8Array,
  stub: ArchiveFollowerStub,
): Promise<Uint8Array> {
  const diff = encodeStateSince(doc, lastKnownSv);
  if (diff.length === 0) return lastKnownSv;
  const newSv = await stub.applyDiff(diff);
  return regressFollowerSv(lastKnownSv, newSv) ? new Uint8Array() : newSv;
}

/** True when the follower's SV shrank — next push must carry the full doc. */
export function regressFollowerSv(previous: Uint8Array, next: Uint8Array): boolean {
  return next.byteLength < previous.byteLength;
}

export async function seedFollower(stub: ArchiveFollowerStub, initialState: Uint8Array): Promise<Uint8Array> {
  TypeError.invariant(initialState.byteLength > 0, "seedFollower: yjsState must not be empty");
  return stub.seed(initialState);
}
