import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { MESSAGE_SYNC } from "../constants.js";
import { ToyLeaderDO, type ToyEnv } from "./toy-leader-do.js";
import { FakeCtx, FakeServerWebSocket } from "./test-do-ctx.js";

/**
 * `isReadOnlyConnection` hook: read-only peers keep the receive path
 * (syncStep1 answered, broadcasts delivered) while their inbound
 * syncStep2/update frames are dropped before touching the doc. The consumer
 * contract this pins: a viewer on an ephemeral inhuman room must never land
 * CRDT edits on the owner's disk (inhuman-sync-spec.md §4.3).
 */
class RoleAwareLeaderDO extends ToyLeaderDO {
  protected override isReadOnlyConnection(ws: WebSocket): boolean {
    const attachment = ws.deserializeAttachment() as { readOnly?: boolean } | null;
    return attachment?.readOnly === true;
  }
}

async function bootRoleAware(): Promise<{ leader: RoleAwareLeaderDO; ctx: FakeCtx }> {
  const ctx = new FakeCtx();
  const leader = new RoleAwareLeaderDO(ctx as unknown as DurableObjectState, { TEST_MODE: true } as ToyEnv);
  await ctx.waitForBoot();
  return { leader, ctx };
}

function updateFrame(value: string): ArrayBuffer {
  const source = new Y.Doc();
  source.getMap("root").set("k", value);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(source));
  const bytes = encoding.toUint8Array(encoder);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function syncStep1Frame(): ArrayBuffer {
  const empty = new Y.Doc();
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, empty);
  const bytes = encoding.toUint8Array(encoder);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function socketWithAttachment(attachment: unknown): FakeServerWebSocket {
  const ws = new FakeServerWebSocket();
  ws.serializeAttachment(attachment);
  return ws;
}

describe("PlexusLeaderSyncDO — isReadOnlyConnection", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("drops a read-only peer's update frame — doc untouched", async () => {
    const { leader } = await bootRoleAware();
    const viewer = socketWithAttachment({ readOnly: true });

    await leader.webSocketMessage(viewer as unknown as WebSocket, updateFrame("stranger-edit"));

    expect(leader.doc.getMap("root").get("k")).toBeUndefined();
  });

  it("applies the same frame from a writer peer", async () => {
    const { leader } = await bootRoleAware();
    const writer = socketWithAttachment({ readOnly: false });

    await leader.webSocketMessage(writer as unknown as WebSocket, updateFrame("owner-edit"));

    expect(leader.doc.getMap("root").get("k")).toBe("owner-edit");
  });

  it("still answers a read-only peer's syncStep1 (catch-up receive path intact)", async () => {
    const { leader } = await bootRoleAware();
    leader.doc.getMap("root").set("k", "existing-state");
    const viewer = socketWithAttachment({ readOnly: true });

    await leader.webSocketMessage(viewer as unknown as WebSocket, syncStep1Frame());

    expect(viewer.binaryFrames().length).toBeGreaterThan(0);
  });

  it("default hook keeps every peer writable (base-class behavior unchanged)", async () => {
    const ctx = new FakeCtx();
    const leader = new ToyLeaderDO(ctx as unknown as DurableObjectState, { TEST_MODE: true } as ToyEnv);
    await ctx.waitForBoot();
    const anyPeer = socketWithAttachment({ readOnly: true }); // attachment ignored by default hook

    await leader.webSocketMessage(anyPeer as unknown as WebSocket, updateFrame("still-applies"));

    expect(leader.doc.getMap("root").get("k")).toBe("still-applies");
  });
});
