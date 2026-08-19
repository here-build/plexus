/**
 * CodeMirror peer frame — receives a MessagePort + seed state from the host story,
 * connects Plexus, bridges via YMessagePortProvider, mounts the editor.
 */
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { PlexusText, toText } from "@here.build/plexus-text";
import { plexusTextSync } from "@here.build/plexus-text-codemirror";
import { YMessagePortProvider } from "@here.build/y-messageport";
import * as Y from "yjs";

import {
  announcePeerListening,
  isBridgeInit,
  isBridgePing,
  type BridgeReadyMessage,
} from "./protocol.js";

const roleEl = document.getElementById("role")!;
const statusEl = document.getElementById("status")!;
const editorEl = document.getElementById("editor")!;

function setStatus(s: string) {
  statusEl.textContent = s;
}

let started = false;

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

  // Share Plexus multi-channel awareness with the MessagePort provider so carets
  // ride the same bridge as CRDT updates.
  const provider = new YMessagePortProvider(doc, port, {
    awareness: plexus.awareness as never,
  });

  provider.on("status", ({ status }) => setStatus(status));
  provider.on("sync", (synced: boolean) => {
    if (synced) setStatus("synced · type in either pane");
  });

  const view = new EditorView({
    doc: toText(root),
    extensions: [
      basicSetup,
      EditorView.theme({
        "&": { height: "100%", backgroundColor: "#0f1115", color: "#e8eaed" },
        ".cm-content": { caretColor: user.color },
        "&.cm-focused .cm-cursor": { borderLeftColor: user.color },
        ".cm-gutters": { backgroundColor: "#161a22", color: "#6b7280", border: "none" },
      }),
      // projector default "auto" → P1 via Y.Array observe when doc-connected
      plexusTextSync(root, {
        doc,
        plexus,
        user,
        projector: "auto",
      }),
    ],
    parent: editorEl,
  });

  const ready: BridgeReadyMessage = { type: "plexus-bridge-ready", role };
  window.parent.postMessage(ready, "*");

  window.addEventListener("pagehide", () => {
    provider.destroy();
    view.destroy();
  });
});

// Listener is live — tell the host it can transfer MessagePorts.
setStatus("listening for bridge…");
announcePeerListening();
