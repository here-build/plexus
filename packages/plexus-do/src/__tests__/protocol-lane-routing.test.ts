import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "../constants.js";
import { handleYjsFrame, type ProtocolRouting } from "../protocol.js";
import type { ResolvedLane } from "../types.js";

/**
 * Sibling-lane wire routing: MESSAGE_SYNC keeps prime-doc semantics; a sibling
 * lane's message type reaches its own doc without leaking writes into prime.
 * (Ported from here.build's ProjectCollaborationDO comments-lane coverage when
 * the DO reparented onto this base.)
 */
function makeRouting(): { routing: ProtocolRouting; primeDoc: Y.Doc; commentsDoc: Y.Doc } {
  const primeDoc = new Y.Doc();
  const commentsDoc = new Y.Doc();
  const prime: ResolvedLane = { id: "prime", messageType: MESSAGE_SYNC, persistKey: "yjs-state", doc: primeDoc };
  const comments: ResolvedLane = {
    id: "comments",
    messageType: MESSAGE_COMMENTS_SYNC,
    persistKey: "yjs-state-comments",
    doc: commentsDoc,
  };
  return { routing: { prime, extraLanes: [comments] }, primeDoc, commentsDoc };
}

function frameWithUpdate(messageType: number, update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageType);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function sourceUpdate(value: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("root").set("k", value);
  return Y.encodeStateAsUpdate(doc);
}

describe("handleYjsFrame — sibling-lane routing", () => {
  it("routes a sibling-lane update to its own doc, not prime", () => {
    const { routing, primeDoc, commentsDoc } = makeRouting();
    handleYjsFrame(frameWithUpdate(MESSAGE_COMMENTS_SYNC, sourceUpdate("comments-only")), routing, {});
    expect(commentsDoc.getMap("root").get("k")).toBe("comments-only");
    expect(primeDoc.getMap("root").get("k")).toBeUndefined();
  });

  it("routes a prime update to prime only", () => {
    const { routing, primeDoc, commentsDoc } = makeRouting();
    handleYjsFrame(frameWithUpdate(MESSAGE_SYNC, sourceUpdate("prime-only")), routing, {});
    expect(primeDoc.getMap("root").get("k")).toBe("prime-only");
    expect(commentsDoc.getMap("root").get("k")).toBeUndefined();
  });

  it("readOnly blocks sibling-lane writes", () => {
    const { routing, commentsDoc } = makeRouting();
    handleYjsFrame(frameWithUpdate(MESSAGE_COMMENTS_SYNC, sourceUpdate("blocked")), routing, {}, undefined, {
      readOnly: true,
    });
    expect(commentsDoc.getMap("root").get("k")).toBeUndefined();
  });

  it("drops a lane whose inbound gate rejects the socket", () => {
    const { routing, commentsDoc } = makeRouting();
    const blocked = {} as unknown as WebSocket;
    handleYjsFrame(frameWithUpdate(MESSAGE_COMMENTS_SYNC, sourceUpdate("gated")), routing, {}, blocked, {
      allowMessageType: (messageType) => messageType !== MESSAGE_COMMENTS_SYNC,
    });
    expect(commentsDoc.getMap("root").get("k")).toBeUndefined();
  });
});
