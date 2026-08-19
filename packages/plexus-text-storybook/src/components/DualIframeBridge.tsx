import { Plexus } from "@here.build/plexus";
import { insertTextAt, PlexusText } from "@here.build/plexus-text";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import * as Y from "yjs";

import type { BridgeInitMessage, BridgeUser } from "../iframe/protocol.js";

export type DualIframeBridgeProps = {
  /** Which editor peer HTML to load. */
  editor: "cm" | "lexical";
  /** Seed plain text written into the shared doc before iframes connect. */
  seedText?: string;
  leftUser?: BridgeUser;
  rightUser?: BridgeUser;
  height?: number | string;
};

const DEFAULT_LEFT: BridgeUser = { name: "Ada", color: "#30bced" };
const DEFAULT_RIGHT: BridgeUser = { name: "Gus", color: "#ec368d" };

/**
 * Host that:
 *  1. Bootstraps a seed PlexusText doc
 *  2. Opens two same-origin iframes
 *  3. Transfers one end of a MessageChannel to each via postMessage
 *  4. Peers connect() from seed state and sync over YMessagePortProvider
 */
export function DualIframeBridge(props: DualIframeBridgeProps): ReactElement {
  const {
    editor,
    seedText = "Hello from the local Plexus bridge.\nEdit either side — CRDT + awareness ride MessagePort.",
    leftUser = DEFAULT_LEFT,
    rightUser = DEFAULT_RIGHT,
    height = "70vh",
  } = props;

  const leftRef = useRef<HTMLIFrameElement>(null);
  const rightRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState("seeding…");
  const ready = useRef({ left: false, right: false });

  const src = editor === "cm" ? "/iframe-cm.html" : "/iframe-lexical.html";

  const seed = useMemo(() => {
    const guid = `story-${crypto.randomUUID()}`;
    const doc = new Y.Doc({ guid });
    const seedPlexus = Plexus.bootstrap(new PlexusText({}), guid, doc) as Plexus<PlexusText>;
    insertTextAt(seedPlexus.root as PlexusText, 0, seedText);
    const encoded = Y.encodeStateAsUpdate(doc);
    // Own a detached copy — peers connect() from this seed after we destroy the seed doc.
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    doc.destroy();
    return { guid, state: copy.buffer };
  }, [seedText]);

  useEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return;

    const channel = new MessageChannel();
    let cancelled = false;
    let booted = false;
    const listening = { left: false, right: false };

    const sendInit = (iframe: HTMLIFrameElement, port: MessagePort, role: "left" | "right", user: BridgeUser) => {
      const msg: BridgeInitMessage = {
        type: "plexus-bridge-init",
        guid: seed.guid,
        state: seed.state,
        user,
        role,
      };
      // Same-origin storybook static; '*' is fine for the demo handshake.
      iframe.contentWindow?.postMessage(msg, "*", [port]);
    };

    const boot = () => {
      if (cancelled || booted) return;
      if (!listening.left || !listening.right) return;
      booted = true;
      setStatus("handing ports to iframes…");
      ready.current = { left: false, right: false };
      sendInit(left, channel.port1, "left", leftUser);
      sendInit(right, channel.port2, "right", rightUser);
    };

    const onMessage = (ev: MessageEvent) => {
      // Peer module finished: listener is attached. Identity by source window.
      if (ev.data?.type === "plexus-bridge-peer-listening") {
        if (booted) return; // late re-announces from ping timers — ignore
        if (ev.source === left.contentWindow) listening.left = true;
        if (ev.source === right.contentWindow) listening.right = true;
        if (listening.left && listening.right) {
          setStatus("peers listening · transferring ports…");
          boot();
        } else {
          setStatus(
            `waiting for peers… L=${listening.left ? "ok" : "…"} R=${listening.right ? "ok" : "…"}`,
          );
        }
        return;
      }
      if (ev.data?.type !== "plexus-bridge-ready") return;
      if (ev.data.role === "left") ready.current.left = true;
      if (ev.data.role === "right") ready.current.right = true;
      if (ready.current.left && ready.current.right) {
        setStatus("both peers ready · MessageChannel bridge live");
      }
    };
    window.addEventListener("message", onMessage);

    // Ask already-loaded peers to re-announce (race: they pinged before we listened).
    const ping = () => {
      left.contentWindow?.postMessage({ type: "plexus-bridge-ping" }, "*");
      right.contentWindow?.postMessage({ type: "plexus-bridge-ping" }, "*");
    };
    const onLoad = () => ping();
    left.addEventListener("load", onLoad);
    right.addEventListener("load", onLoad);
    if (left.contentDocument?.readyState === "complete") ping();
    if (right.contentDocument?.readyState === "complete") ping();
    // Keep poking briefly — Vite can finish the module graph after document load.
    const timers = [50, 150, 400, 1000].map((ms) => window.setTimeout(ping, ms));

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
      left.removeEventListener("load", onLoad);
      right.removeEventListener("load", onLoad);
      for (const t of timers) window.clearTimeout(t);
      try {
        channel.port1.close();
        channel.port2.close();
      } catch {
        /* already closed by peers */
      }
    };
  }, [seed, leftUser, rightUser]);

  const frameStyle: CSSProperties = {
    flex: 1,
    border: "1px solid #2a2f3a",
    borderRadius: 8,
    background: "#0f1115",
    minWidth: 0,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height,
        background: "#0b0d12",
        color: "#e8eaed",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <header
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid #2a2f3a",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          fontSize: 13,
        }}
      >
        <div>
          <strong>Cross-iframe Plexus bridge</strong>
          <span style={{ opacity: 0.65, marginLeft: 8 }}>
            MessageChannel → YMessagePortProvider · shared Y.Doc guid · PlexusAwareness carets
          </span>
        </div>
        <div style={{ opacity: 0.8 }}>{status}</div>
      </header>
      <div style={{ flex: 1, display: "flex", gap: 10, padding: 10, minHeight: 0 }}>
        <iframe
          ref={leftRef}
          title={`${editor}-left`}
          src={src}
          style={frameStyle}
          // Same-origin so we can transfer MessagePorts
        />
        <iframe ref={rightRef} title={`${editor}-right`} src={src} style={frameStyle} />
      </div>
    </div>
  );
}
