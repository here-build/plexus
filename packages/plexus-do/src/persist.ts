/**
 * Leader DO persistence scheduler.
 *
 * Write-driven cadence: the DO arms an alarm only when there is unpersisted
 * state. Presence/connection alone never arms — that is what defeats hibernation.
 *
 * Compose: trailing-edge debounce (coalesce typing bursts) clamped by an
 * optional ceiling (bound RPO during continuous editing). `nextAlarmTarget`
 * only ADVANCES an already-scheduled alarm — a late edit must not push back a
 * persist an earlier edit already pinned.
 *
 * Version counters (`dirtyVersion` / `persistedVersion`) prevent the alarm
 * race: `alarm()` snapshots `versionAtSnapshot` before async encode+put; edits
 * arriving during the await bump `dirtyVersion` past that value so the alarm
 * re-arms instead of falsely marking clean.
 */

import * as Y from "yjs";

import { GENESIS_ORIGIN, REHYDRATE_ORIGIN } from "./constants.js";
import type { PersistPolicy, ResolvedLane } from "./types.js";

export interface PersistLaneState {
  dirtyVersion: number;
  persistedVersion: number;
}

export interface PersistSchedulerHooks {
  now?: () => number;
  testMode?: boolean;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export class PersistScheduler {
  private lastPersistFireMs: number;

  readonly lanes: Map<string, PersistLaneState>;

  constructor(
    private readonly policy: PersistPolicy,
    private readonly hooks: PersistSchedulerHooks = {},
  ) {
    this.lastPersistFireMs = this.now();
    this.lanes = new Map();
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  laneState(id: string): PersistLaneState {
    let state = this.lanes.get(id);
    if (!state) {
      state = { dirtyVersion: 0, persistedVersion: 0 };
      this.lanes.set(id, state);
    }
    return state;
  }

  /** Peer-origined doc update — not {@link REHYDRATE_ORIGIN} / {@link GENESIS_ORIGIN}. */
  markDirty(laneId: string): void {
    this.laneState(laneId).dirtyVersion++;
  }

  hasPendingWork(laneId: string): boolean {
    const state = this.laneState(laneId);
    return state.dirtyVersion > state.persistedVersion;
  }

  hasAnyPendingWork(): boolean {
    for (const id of this.lanes.keys()) {
      if (this.hasPendingWork(id)) return true;
    }
    return false;
  }

  /**
   * Next alarm timestamp, or null when test mode / nothing dirty.
   * Returns `existingAlarm` unchanged when the computed target would defer it.
   */
  nextAlarmTarget(existingAlarm: number | null): number | null {
    if (this.hooks.testMode) return null;
    if (!this.hasAnyPendingWork()) return null;

    const now = this.now();
    const debounceTarget = now + this.policy.debounceMs;
    const ceilingTarget =
      this.policy.ceilingMs != null ? this.lastPersistFireMs + this.policy.ceilingMs : Number.POSITIVE_INFINITY;
    const target = Math.min(debounceTarget, ceilingTarget);
    if (existingAlarm === null || target < existingAlarm) return target;
    return existingAlarm;
  }

  /** Capture before async persist — compare to `markPersisted` after put completes. */
  versionAtSnapshot(laneId: string): number {
    return this.laneState(laneId).dirtyVersion;
  }

  markPersisted(laneId: string, versionAtSnapshot: number): void {
    this.laneState(laneId).persistedVersion = versionAtSnapshot;
    this.lastPersistFireMs = this.now();
  }
}

// ── Lane persist helpers ─────────────────────────────────────────────────────

/** Apply stored bytes on boot with the rehydrate origin tag. */
export function applyRehydrate(doc: Y.Doc, bytes: Uint8Array): void {
  Y.applyUpdate(doc, bytes, REHYDRATE_ORIGIN);
}

/** Substrate-internal origins — must not broadcast or mark dirty. */
export function shouldIgnoreUpdateOrigin(origin: unknown): boolean {
  return origin === REHYDRATE_ORIGIN || origin === GENESIS_ORIGIN;
}

export async function persistLaneSnapshot(
  storage: DurableObjectStorage,
  lane: ResolvedLane,
  versionAtSnapshot: number,
  scheduler: PersistScheduler,
): Promise<void> {
  const snapshot = Y.encodeStateAsUpdate(lane.doc);
  await storage.put(lane.persistKey, snapshot);
  scheduler.markPersisted(lane.id, versionAtSnapshot);
}