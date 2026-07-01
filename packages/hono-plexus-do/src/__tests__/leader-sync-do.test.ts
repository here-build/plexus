import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { GENESIS_ORIGIN, MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "../constants.js";
import { ToyLeaderDO, ToyMultiLaneDO } from "./toy-leader-do.js";
import { FakeCtx, FakeServerWebSocket } from "./test-do-ctx.js";

async function bootToyLeader(testMode = true): Promise<{ leader: ToyLeaderDO; ctx: FakeCtx }> {
  const ctx = new FakeCtx();
  const leader = new ToyLeaderDO(ctx as unknown as DurableObjectState, { TEST_MODE: testMode });
  await ctx.waitForBoot();
  return { leader, ctx };
}

describe("PlexusLeaderSyncDO integration", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("seed() applies with GENESIS_ORIGIN and does not arm persist or onLaneUpdate", async () => {
    const { leader } = await bootToyLeader();

    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    const bytes = Y.encodeStateAsUpdate(source);

    await leader.seed("proj-1", bytes);

    expect(leader.laneUpdateOrigins).toHaveLength(0);

    const storedAfterSeed = (await leader.getSnapshot()).slice();
    await leader.alarm();
    expect((await leader.getSnapshot()).slice()).toEqual(storedAfterSeed);

    leader.doc.transact(() => {
      leader.doc.getMap("probe").set("y", 2);
    }, "peer");
    expect(leader.laneUpdateOrigins).toContain("peer");

    const snapshot = await leader.getSnapshot();
    const replay = new Y.Doc();
    let seenOrigin: unknown;
    replay.on("update", (_u, origin) => {
      seenOrigin = origin;
    });
    Y.applyUpdate(replay, snapshot, GENESIS_ORIGIN);
    expect(seenOrigin).toBe(GENESIS_ORIGIN);
    expect(replay.getMap("root").get("k")).toBe(1);
  });

  it("seed() passes post-merge bytes to the archive follower", async () => {
    const { leader } = await bootToyLeader();

    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    await leader.seed("proj-1", Y.encodeStateAsUpdate(source));

    expect(leader.follower.seeds).toHaveLength(1);
    const merged = leader.follower.seeds[0]!;
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, merged);
    expect(decoded.getMap("root").get("k")).toBe(1);
  });

  it("skips follower push when lane persist fails in alarm()", async () => {
    const { leader, ctx } = await bootToyLeader(false);
    await leader.recordEntityIdForTest("proj-1");

    leader.doc.getMap("root").set("k", 1);
    leader.doc.transact(() => {
      leader.doc.getMap("root").set("k", 2);
    }, "peer");

    ctx.storage.failPutKeys.add("yjs-state");

    await leader.alarm();

    expect(leader.follower.diffs).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("broadcasts a lane update to every peer except the origin socket", async () => {
    const { leader, ctx } = await bootToyLeader();
    const a = new FakeServerWebSocket();
    const b = new FakeServerWebSocket();
    ctx.acceptWebSocket(a);
    ctx.acceptWebSocket(b);

    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    // Mimic socket A having sent this edit — the doc update carries A as origin.
    Y.applyUpdate(leader.doc, Y.encodeStateAsUpdate(source), a);

    expect(b.binaryFrames().length).toBeGreaterThan(0); // B receives the broadcast
    expect(a.binaryFrames().length).toBe(0); // A is the origin — excluded
    expect(b.binaryFrames()[0]![0]).toBe(MESSAGE_SYNC); // framed on the prime lane
  });

  it("spawns sibling-lane docs when a subclass overrides lanes via getter", async () => {
    const ctx = new FakeCtx();
    const leader = new ToyMultiLaneDO(ctx as unknown as DurableObjectState, { TEST_MODE: true });
    await ctx.waitForBoot();

    // laneDoc("comments") resolves — regression guard for lanes read during super().
    expect(() => leader.commentsDoc()).not.toThrow();

    // Edits to the sibling doc broadcast on the comments message type, independent of prime.
    const b = new FakeServerWebSocket();
    ctx.acceptWebSocket(b);
    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    Y.applyUpdate(leader.commentsDoc(), Y.encodeStateAsUpdate(source), "peer");
    expect(b.binaryFrames().some((f) => f[0] === MESSAGE_COMMENTS_SYNC)).toBe(true);
    expect(b.binaryFrames().some((f) => f[0] === MESSAGE_SYNC)).toBe(false);
  });

  it("pushes to follower after successful lane persist in alarm()", async () => {
    const { leader, ctx } = await bootToyLeader(false);
    await leader.recordEntityIdForTest("proj-1");

    leader.doc.getMap("root").set("k", 1);
    leader.doc.transact(() => {
      leader.doc.getMap("root").set("k", 2);
    }, "peer");

    await leader.alarm();

    expect(leader.follower.diffs.length).toBeGreaterThan(0);
    expect(ctx.storage.snapshot()["yjs-state"]).toBeInstanceOf(Uint8Array);
  });
});