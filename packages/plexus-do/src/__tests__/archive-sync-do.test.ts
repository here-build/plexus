import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { PlexusArchiveSyncDO } from "../archive-sync-do.js";
import type { PlexusSyncEnv } from "../types.js";
import { FakeCtx } from "./test-do-ctx.js";

class ToyArchiveDO extends PlexusArchiveSyncDO<PlexusSyncEnv> {
  protected override entityId(): string {
    return "proj-1";
  }
}

async function bootArchive(): Promise<{ archive: ToyArchiveDO; ctx: FakeCtx }> {
  const ctx = new FakeCtx();
  const archive = new ToyArchiveDO(ctx as unknown as DurableObjectState, { TEST_MODE: true });
  await ctx.waitForBoot();
  return { archive, ctx };
}

describe("PlexusArchiveSyncDO", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("seed() applies bytes, persists, and returns the resulting state vector", async () => {
    const { archive, ctx } = await bootArchive();
    const source = new Y.Doc();
    source.getMap("root").set("k", 1);

    const sv = await archive.seed(Y.encodeStateAsUpdate(source));

    expect(sv.byteLength).toBeGreaterThan(0);
    expect(ctx.storage.snapshot()["archive-state"]).toBeInstanceOf(Uint8Array);
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, archive.getStateAtVector(new Uint8Array()));
    expect(decoded.getMap("root").get("k")).toBe(1);
  });

  it("applyDiff() returns the new SV immediately and persists via waitUntil", async () => {
    const { archive, ctx } = await bootArchive();
    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    const sv1 = await archive.seed(Y.encodeStateAsUpdate(source));

    source.getMap("root").set("k2", 2);
    const diff = Y.encodeStateAsUpdate(source, sv1);
    const sv2 = archive.applyDiff(diff); // synchronous return
    expect(sv2.byteLength).toBeGreaterThanOrEqual(sv1.byteLength);

    await ctx.flush(); // drain the waitUntil persist
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, ctx.storage.snapshot()["archive-state"] as Uint8Array);
    expect(persisted.getMap("root").get("k2")).toBe(2);
  });

  it("applyDiff() is idempotent (at-least-once push is safe)", async () => {
    const { archive } = await bootArchive();
    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    const full = Y.encodeStateAsUpdate(source);

    const svA = archive.applyDiff(full);
    const svB = archive.applyDiff(full); // replay
    expect([...svB]).toEqual([...svA]); // no state change on replay
  });

  it("getStateAtVector() with an empty SV returns full state (no 0-byte decode)", async () => {
    const { archive } = await bootArchive();
    const source = new Y.Doc();
    source.getMap("root").set("k", "v");
    await archive.seed(Y.encodeStateAsUpdate(source));

    const full = archive.getStateAtVector(new Uint8Array());
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, full);
    expect(decoded.getMap("root").get("k")).toBe("v");
  });

  it("markSnapshot / getSnapshotState store a labeled copy", async () => {
    const { archive } = await bootArchive();
    const bytes = new Uint8Array([1, 2, 3]);
    await archive.markSnapshot("v1", bytes);
    expect(await archive.getSnapshotState("v1")).toEqual(bytes);
    expect(await archive.getSnapshotState("missing")).toBeUndefined();
  });

  it("corrupt stored archive starts empty so the leader can reseed", async () => {
    const ctx = new FakeCtx();
    await ctx.storage.put("archive-state", new Uint8Array([255, 255, 255]));
    const archive = new ToyArchiveDO(ctx as unknown as DurableObjectState, { TEST_MODE: true });
    await ctx.waitForBoot();
    expect(archive.getStateVector().byteLength).toBeGreaterThanOrEqual(0);
    expect(archive.archive.getMap("root").size).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
  });
});
