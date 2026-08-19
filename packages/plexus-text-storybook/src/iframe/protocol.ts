/** Host ↔ iframe handshake over postMessage + transferred MessagePort. */

export type BridgeUser = { name: string; color: string };

export type BridgeInitMessage = {
  type: "plexus-bridge-init";
  /** Shared Y.Doc guid — both peers must use the same guid. */
  guid: string;
  /** Seed state so both peers connect() to the same root entity. */
  state: ArrayBuffer;
  user: BridgeUser;
  role: "left" | "right";
};

export type BridgeReadyMessage = {
  type: "plexus-bridge-ready";
  role: "left" | "right";
};

/** Peer announces its message listener is attached (module graph finished). */
export type BridgePeerListeningMessage = {
  type: "plexus-bridge-peer-listening";
};

/** Host asks a peer to re-announce if the first listening ping was missed. */
export type BridgePingMessage = {
  type: "plexus-bridge-ping";
};

export function isBridgeInit(data: unknown): data is BridgeInitMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as BridgeInitMessage).type === "plexus-bridge-init" &&
    typeof (data as BridgeInitMessage).guid === "string"
  );
}

export function isBridgePing(data: unknown): data is BridgePingMessage {
  return typeof data === "object" && data !== null && (data as BridgePingMessage).type === "plexus-bridge-ping";
}

export function announcePeerListening(): void {
  const msg: BridgePeerListeningMessage = { type: "plexus-bridge-peer-listening" };
  window.parent.postMessage(msg, "*");
}
