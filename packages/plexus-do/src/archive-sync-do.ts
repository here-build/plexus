/**
 * PlexusArchiveSyncDO — content-blind `gc:false` archive follower.
 *
 * Purpose: append-only replica of the leader's Y.Doc for audit, publish-version
 * artifact retrieval, and disaster recovery. The leader pushes diffs via RPC;
 * this DO returns its state vector after each apply so the leader tracks sync
 * horizon without a separate `getStateVector` round-trip.
 *
 * Persistence:
 *   1. DO storage (`archiveStorageKey`) — primary hot replica; `applyDiff` /
 *      `seed` schedule persist via `waitUntil` so RPC returns the SV first.
 *   2. Optional R2 midnight spill — date-keyed cold copy; one-shot alarm.
 *
 * Failure model: replica is disposable. Leader is authoritative for live state.
 * Yjs `applyUpdate` is idempotent — at-least-once push is safe. SV shrink
 * detection lives on the leader ({@link regressFollowerSv}).
 *
 * RPC-only — no WebSocket. Intentionally Plexus-agnostic.
 */

import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";

import { REHYDRATE_ORIGIN } from "./constants.js";
import { ensureMidnightSpillAlarm, spillDocToR2 } from "./spill.js";
import type { ArchiveSpillPolicy, PlexusSyncEnv } from "./types.js";

export abstract class PlexusArchiveSyncDO<Env extends PlexusSyncEnv> extends DurableObject<Env> {
  protected readonly archiveStorageKey = "archive-state";
  // gc:false retains tombstones — point-in-time reconstruction must be exact.
  readonly archive = new Y.Doc({ gc: false });

  /**
   * Entity id for R2 keys. Archive DOs are typically `idFromName(projectId)`
   * — `ctx.id.name` is available here (unlike the leader interior).
   */
  protected abstract entityId(): string;

  protected spillPolicy(): ArchiveSpillPolicy | null {
    return null;
  }

  protected isTestModeEnabled(): boolean {
    return Boolean(this.env.TEST_MODE);
  }

  protected onDiffApplied(_diff: Uint8Array): void {}

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // eslint-disable-next-line sonarjs/no-async-constructor
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Uint8Array>(this.archiveStorageKey);
      if (!stored) return;
      try {
        Y.applyUpdate(this.archive, stored, REHYDRATE_ORIGIN);
      } catch (error) {
        // Replica is disposable — never brick boot; the leader reseeds via full-diff push.
        console.error("[PlexusArchiveSyncDO] corrupt archive snapshot — starting empty, leader will reseed:", error);
      }
    });
  }

  /**
   * First-touch seed from leader. Awaited persist — follower must be durable
   * before the leader records its horizon SV.
   */
  async seed(initialState: Uint8Array): Promise<Uint8Array> {
    Y.applyUpdate(this.archive, initialState);
    await this.persistArchive();
    await this.armSpillAlarm();
    return Y.encodeStateVector(this.archive);
  }

  /**
   * Apply leader diff. Returns resulting SV immediately; persist + alarm arm
   * run in `waitUntil` (CF completes before suspension).
   */
  applyDiff(diff: Uint8Array): Uint8Array {
    Y.applyUpdate(this.archive, diff);
    this.onDiffApplied(diff);
    const sv = Y.encodeStateVector(this.archive);
    this.ctx.waitUntil(this.persistAndArm());
    return sv;
  }

  /**
   * Diff a peer needs to catch up. Empty `targetSV` → full encoded state
   * (empty SV is NOT decoded as a 0-byte SV — lib0 would throw).
   */
  getStateAtVector(targetSv: Uint8Array): Uint8Array {
    return targetSv.byteLength === 0
      ? Y.encodeStateAsUpdate(this.archive)
      : Y.encodeStateAsUpdate(this.archive, targetSv);
  }

  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.archive);
  }

  async markSnapshot(label: string, state: Uint8Array): Promise<void> {
    await this.ctx.storage.put(`snapshot:${label}`, state);
  }

  async getSnapshotState(label: string): Promise<Uint8Array | null> {
    return (await this.ctx.storage.get<Uint8Array>(`snapshot:${label}`)) ?? null;
  }

  async alarm(): Promise<void> {
    const spill = this.spillPolicy();
    if (!spill || this.isTestModeEnabled()) return;
    try {
      await spillDocToR2(this.archive, this.entityId(), spill);
    } catch (error) {
      console.error(`[PlexusArchiveSyncDO:${this.entityId()}] spill failed:`, error);
    }
  }

  private async persistAndArm(): Promise<void> {
    await this.persistArchive();
    await this.armSpillAlarm();
  }

  private async persistArchive(): Promise<void> {
    await this.ctx.storage.put(this.archiveStorageKey, Y.encodeStateAsUpdate(this.archive));
  }

  private async armSpillAlarm(): Promise<void> {
    if (!this.spillPolicy()) return;
    await ensureMidnightSpillAlarm(this.ctx.storage, this.isTestModeEnabled());
  }
}
