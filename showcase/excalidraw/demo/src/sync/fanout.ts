import { YMessagePortProviderOrigin } from "@here.build/y-messageport";
import { encodeFrame, messageSync } from "@here.build/y-messageport/protocol";
import { writeUpdate } from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import type * as Y from "yjs";

/**
 * N `YMessagePortProvider`s on one hub doc all apply peer updates with the
 * same origin symbol, so each provider skips sending (it thinks the update
 * is an echo). Forward those applies to every connected port ourselves.
 *
 * Do not transfer `frame.buffer` — transfer is a 1:1 trick. Fan-out clones.
 */
export function fanOutPeerUpdates(hub: Y.Doc, peers: Set<{ port: MessagePort }>): () => void {
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== YMessagePortProviderOrigin) return;
    for (const peer of peers) {
      const inner = encoding.createEncoder();
      writeUpdate(inner, update);
      const frame = encodeFrame(messageSync, encoding.toUint8Array(inner));
      try {
        peer.port.postMessage(frame);
      } catch {
        peers.delete(peer);
      }
    }
  };
  hub.on("update", onUpdate);
  return () => hub.off("update", onUpdate);
}
