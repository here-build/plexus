import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { GENESIS_ORIGIN, MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "../constants.js";
import { UnknownLaneError } from "../errors.js";
import type { AwarenessPlane, LaneDescriptor, PresenceContext, PresenceProjector } from "../types.js";
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

  it("rejects an empty seed and an unknown lane id", async () => {
    const { leader } = await bootToyLeader();
    await expect(leader.seed("proj-1", new Uint8Array())).rejects.toThrow(/empty/);
    await expect(leader.getSnapshot("missing")).rejects.toThrow(UnknownLaneError);
  });

  it("cleanup() wipes storage and the follower horizon; the in-memory doc stays", async () => {
    const { leader, ctx } = await bootToyLeader();
    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    await leader.seed("proj-1", Y.encodeStateAsUpdate(source));
    expect(ctx.storage.snapshot()["yjs-state"]).toBeInstanceOf(Uint8Array);

    await leader.cleanup();
    expect(ctx.storage.snapshot()["yjs-state"]).toBeUndefined();
    expect(leader.doc.getMap("root").get("k")).toBe(1);
  });

  it("getDiff() returns only ops the caller is missing", async () => {
    const { leader } = await bootToyLeader();
    leader.doc.getMap("root").set("a", 1);
    const snapshot = await leader.getSnapshot();
    const sv = await leader.getStateVector();
    leader.doc.getMap("root").set("b", 2);
    const diff = await leader.getDiff(sv);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, snapshot);
    Y.applyUpdate(peer, diff);
    expect(peer.getMap("root").get("b")).toBe(2);
  });

  it("corrupt persistKey snapshot boots empty so peers can resync", async () => {
    const ctx = new FakeCtx();
    await ctx.storage.put("yjs-state", new Uint8Array([255, 255, 255]));
    const leader = new ToyLeaderDO(ctx as unknown as DurableObjectState, { TEST_MODE: true });
    await ctx.waitForBoot();
    expect(leader.doc.getMap("root").size).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("fetch: no upgrade → 426; rejected handshake → 401", async () => {
    const { leader } = await bootToyLeader();
    const http = await leader.fetch(new Request("https://do/docs/x"));
    expect(http.status).toBe(426);

    const denied = await leader.fetch(
      new Request("https://do/docs/x", { headers: { Upgrade: "websocket" } }),
    );
    expect(denied.status).toBe(401);
  });

  it("broadcastFilter drops outbound frames for a rejected socket", async () => {
    const ctx = new FakeCtx();
    const leader = new FilteredCommentsDO(ctx as unknown as DurableObjectState, { TEST_MODE: true });
    await ctx.waitForBoot();
    const allowed = new FakeServerWebSocket();
    const blocked = new FakeServerWebSocket();
    allowed.serializeAttachment({ commentsAllowed: true });
    blocked.serializeAttachment({ commentsAllowed: false });
    ctx.acceptWebSocket(allowed);
    ctx.acceptWebSocket(blocked);

    const source = new Y.Doc();
    source.getMap("root").set("k", 1);
    Y.applyUpdate(leader.commentsDoc(), Y.encodeStateAsUpdate(source), "peer");

    expect(allowed.binaryFrames().some((f) => f[0] === MESSAGE_COMMENTS_SYNC)).toBe(true);
    expect(blocked.binaryFrames().some((f) => f[0] === MESSAGE_COMMENTS_SYNC)).toBe(false);
  });

  it("projects awareness deltas only after entityId is bound, and on close", async () => {
    const ctx = new FakeCtx();
    const leader = new PresenceLeaderDO(ctx as unknown as DurableObjectState, { TEST_MODE: true });
    await ctx.waitForBoot();

    leader.awarenessPlane.emit({ added: [1], updated: [], removed: [] }, "peer");
    expect(leader.projector.deltas).toHaveLength(0);

    await leader.recordEntityIdForTest("proj-1");
    leader.awarenessPlane.emit({ added: [2], updated: [], removed: [] }, "peer");
    expect(leader.projector.deltas).toHaveLength(1);
    expect(leader.projector.deltas[0]!.ctx.entityId).toBe("proj-1");

    const ws = new FakeServerWebSocket();
    ws.serializeAttachment({ userId: "ada" });
    ctx.acceptWebSocket(ws);
    leader.webSocketClose(ws as unknown as WebSocket);
    expect(leader.projector.closes).toEqual(["ada"]);
  });
});

class FilteredCommentsDO extends ToyMultiLaneDO {
  protected override get lanes(): readonly LaneDescriptor[] {
    return [
      { id: "prime", messageType: MESSAGE_SYNC, persistKey: "yjs-state" },
      {
        id: "comments",
        messageType: MESSAGE_COMMENTS_SYNC,
        persistKey: "yjs-state-comments",
        broadcastFilter: (ws) => {
          const attachment = ws.deserializeAttachment() as { commentsAllowed?: boolean } | null;
          return attachment?.commentsAllowed === true;
        },
      },
    ];
  }
}

class RecordingAwareness implements AwarenessPlane {
  private handler:
    | ((changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void)
    | undefined;

  applyUpdate(): void {}
  encodeUpdate(): Uint8Array {
    return new Uint8Array([1]);
  }
  onChange(handler: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void): void {
    this.handler = handler;
  }
  emit(changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void {
    this.handler?.(changes, origin);
  }
}

class RecordingProjector implements PresenceProjector {
  readonly deltas: { changes: { added: number[]; updated: number[] }; ctx: PresenceContext }[] = [];
  readonly closes: string[] = [];

  onAwarenessDelta(changes: { added: number[]; updated: number[] }, ctx: PresenceContext): void {
    this.deltas.push({ changes, ctx });
  }
  onSocketClose(userId: string): void {
    this.closes.push(userId);
  }
}

class PresenceLeaderDO extends ToyLeaderDO {
  readonly awarenessPlane = new RecordingAwareness();
  readonly projector = new RecordingProjector();

  protected override awareness = this.awarenessPlane;
  protected override presence = this.projector;
}