/**
 * In-memory keyed registry with TTL via alarm.
 *
 * Presence, not CRDT truth. A leader pushes via RPC; entries live only in
 * RAM — hibernation clears the map; clients re-derive on reconnect. The
 * alarm sweeps expiry and reschedules only while entries remain.
 */

import { DurableObject } from "cloudflare:workers";

export abstract class EphemeralRegistryDO<
  K extends string,
  V extends { lastSeen: number },
  Env = unknown,
> extends DurableObject<Env> {
  // ── Subclass contract ──────────────────────────────────────────────────────

  protected abstract entryExpiryMs: number;
  protected abstract alarmIdleMs: number;
  protected abstract isTestMode(): boolean;

  // ── Store ──────────────────────────────────────────────────────────────────

  protected readonly entries = new Map<K, V>();

  // ── RPC ──────────────────────────────────────────────────────────────────────

  upsert(key: K, value: Omit<V, "lastSeen">): void {
    this.entries.set(key, { ...value, lastSeen: Date.now() } as V);
    void this.ensureAlarm();
  }

  remove(key: K): void {
    this.entries.delete(key);
  }

  list(): V[] {
    this.cleanupExpired();
    return [...this.entries.values()];
  }

  async cleanup(): Promise<void> {
    this.entries.clear();
    await this.ctx.storage.deleteAll();
  }

  // ── Alarm ────────────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    this.cleanupExpired();
    if (this.entries.size > 0 && !this.isTestMode()) {
      await this.ctx.storage.setAlarm(Date.now() + this.alarmIdleMs);
    }
  }

  protected cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeen > this.entryExpiryMs) {
        this.entries.delete(key);
      }
    }
  }

  private async ensureAlarm(): Promise<void> {
    if (this.isTestMode()) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing != null) return;
    await this.ctx.storage.setAlarm(Date.now() + this.alarmIdleMs);
  }
}