/**
 * Lexical peer frame — MessagePort bridge + PlexusText, paints remote carets in a HUD.
 */
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { Plexus } from "@here.build/plexus";
import { PlexusText } from "@here.build/plexus-text";
import { bindLexical, type RemoteSelection } from "@here.build/plexus-text-lexical";
import { YMessagePortProvider } from "@here.build/y-messageport";
import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactElement } from "react";
import * as Y from "yjs";

import {
  announcePeerListening,
  isBridgeInit,
  isBridgePing,
  type BridgeReadyMessage,
} from "./protocol.js";

const roleEl = document.getElementById("role")!;
const statusEl = document.getElementById("status")!;
const hostEl = document.getElementById("editor-host")!;
const remotesEl = document.getElementById("remotes") as HTMLUListElement;

function setStatus(s: string) {
  statusEl.textContent = s;
}

let started = false;

function paintRemotes(remotes: RemoteSelection[]) {
  if (remotes.length === 0) {
    remotesEl.hidden = true;
    remotesEl.innerHTML = "";
    return;
  }
  remotesEl.hidden = false;
  remotesEl.innerHTML = remotes
    .map(
      (r) =>
        `<li><span class="dot" style="background:${r.color}"></span>` +
        `${r.user?.name ?? "peer"} · ${r.selection.anchor}–${r.selection.head}</li>`,
    )
    .join("");
}

function PlexusLexicalPlugin(props: {
  text: PlexusText;
  doc: Y.Doc;
  plexus: Plexus<PlexusText>;
  user: { name: string; color: string };
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    // projector default "auto" → P1 via Y.Array observe when doc-connected
    return bindLexical(editor, props.text, {
      doc: props.doc,
      plexus: props.plexus,
      user: props.user,
      projector: "auto",
      onRemoteSelections: paintRemotes,
    });
  }, [editor, props.text, props.doc, props.plexus, props.user]);
  return null;
}

function EditorApp(props: {
  text: PlexusText;
  doc: Y.Doc;
  plexus: Plexus<PlexusText>;
  user: { name: string; color: string };
}): ReactElement {
  const initialConfig = {
    namespace: "plexus-text-story",
    onError: (e: Error) => {
      console.error(e);
    },
    theme: {
      paragraph: "lex-p",
      text: {
        bold: "lex-bold",
        italic: "lex-italic",
        code: "lex-code",
      },
    },
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div style={{ position: "relative", minHeight: "100%" }}>
        <RichTextPlugin
          contentEditable={<ContentEditable className="lex-shell" />}
          placeholder={<div className="lex-placeholder">Type collaboratively…</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <PlexusLexicalPlugin {...props} />
      </div>
      <style>{`
        .lex-bold { font-weight: 700; }
        .lex-italic { font-style: italic; }
        .lex-code { font-family: ui-monospace, monospace; background: #1c2230; padding: 0 3px; border-radius: 3px; }
      `}</style>
    </LexicalComposer>
  );
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (isBridgePing(ev.data)) {
    announcePeerListening();
    return;
  }
  if (!isBridgeInit(ev.data)) return;
  if (started) return;
  const port = ev.ports[0];
  if (!port) {
    setStatus("error: no port transferred");
    return;
  }
  started = true;

  const { guid, state, user, role } = ev.data;
  roleEl.textContent = `${user.name} · ${role}`;
  roleEl.style.color = user.color;
  setStatus("connecting…");

  const doc = new Y.Doc({ guid });
  Y.applyUpdate(doc, new Uint8Array(state));

  const plexus = Plexus.connect(doc) as Plexus<PlexusText>;
  const root = plexus.root as PlexusText;

  const provider = new YMessagePortProvider(doc, port, {
    awareness: plexus.awareness as never,
  });

  provider.on("status", ({ status }) => setStatus(status));
  provider.on("sync", (synced: boolean) => {
    if (synced) setStatus("synced · try bold (⌘/Ctrl-B) + watch carets");
  });

  createRoot(hostEl).render(
    <EditorApp text={root} doc={doc} plexus={plexus} user={user} />,
  );

  const ready: BridgeReadyMessage = { type: "plexus-bridge-ready", role };
  window.parent.postMessage(ready, "*");

  window.addEventListener("pagehide", () => {
    provider.destroy();
  });
});

// Listener is live — tell the host it can transfer MessagePorts.
setStatus("listening for bridge…");
announcePeerListening();
