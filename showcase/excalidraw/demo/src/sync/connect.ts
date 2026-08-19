import { WebsocketProvider } from "y-websocket";
import { YMessagePortProvider } from "@here.build/y-messageport";
import generateSillyName from "sillyname";
import * as Y from "yjs";

import { defaultRoot } from "../seed.js";
import { DemoPlexus } from "./DemoPlexus.js";
import { DOC_GUID } from "./guid.js";

/** Providers live with the tab. The Plexus is the document; this is just the wire. */
const attachments = new Set<{ destroy(): void }>();

const WARMUP_MS = 2000;

function roomId(): string {
  if (typeof location === "undefined") return DOC_GUID;
  return new URLSearchParams(location.search).get("room") ?? DOC_GUID;
}

function userId(): string {
  if (typeof sessionStorage === "undefined") return generateSillyName();
  const key = "plexus-excalidraw-user";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = generateSillyName();
  sessionStorage.setItem(key, next);
  return next;
}

function claimName(plexus: DemoPlexus): void {
  if (!plexus.awareness.name.get()) {
    plexus.awareness.setName(userId());
  }
}

function localOnly(): DemoPlexus {
  const plexus = DemoPlexus.bootstrap(defaultRoot(), roomId()) as DemoPlexus;
  claimName(plexus);
  return plexus;
}

function bindAwareness(doc: Y.Doc, serverUrl: string, path: string, user: string, plexus: DemoPlexus): void {
  attachments.add(
    new WebsocketProvider(serverUrl, path, doc, {
      awareness: plexus.awareness,
      params: { user },
    }),
  );
}

function waitSynced(provider: WebsocketProvider, ms: number): Promise<boolean> {
  if (provider.synced) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      provider.off("sync", onSync);
      resolve(ok);
    };
    const onSync = (synced: boolean) => {
      if (synced) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    provider.on("sync", onSync);
  });
}

/**
 * Warm up the plexus-do host, then bind Plexus.
 *
 * The Worker is the first writer (Scene seed). After the Y.Doc is synced,
 * `DemoPlexus.connect(doc)`. SharedWorker / local bootstrap only if the host
 * is unreachable — two local bootstraps are two trees.
 */
export function connectScene(): Promise<DemoPlexus> {
  if (typeof location === "undefined") {
    return Promise.resolve(localOnly());
  }

  const room = roomId();
  const user = userId();
  const doc = new Y.Doc({ guid: room });
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const serverUrl = `${proto}//${location.host}/docs`;
  const path = `${room}/ws`;

  const warmup = new WebsocketProvider(serverUrl, path, doc, { params: { user } });

  return waitSynced(warmup, WARMUP_MS).then((ok) => {
    if (!ok) {
      warmup.destroy();
      return sharedWorkerOrLocal(doc, room);
    }
    try {
      const plexus = DemoPlexus.connect(doc) as DemoPlexus;
      claimName(plexus);
      warmup.destroy();
      bindAwareness(doc, serverUrl, path, user, plexus);
      return plexus;
    } catch {
      warmup.destroy();
      return sharedWorkerOrLocal(doc, room);
    }
  });
}

/** Local hub when the Worker is down. Isolated tab bootstraps. */
function sharedWorkerOrLocal(failedDoc: Y.Doc, room: string): Promise<DemoPlexus> {
  failedDoc.destroy();
  if (typeof SharedWorker === "undefined") {
    return Promise.resolve(localOnly());
  }

  const doc = new Y.Doc({ guid: room });
  const worker = new SharedWorker(new URL("./scene.worker.ts", import.meta.url), {
    type: "module",
    name: "plexus-excalidraw-scene",
  });
  const handshake = new YMessagePortProvider(doc, worker.port);

  return new Promise((resolve) => {
    const finish = (plexus: DemoPlexus) => {
      claimName(plexus);
      handshake.destroy();
      attachments.add(new YMessagePortProvider(doc, worker.port, { awareness: plexus.awareness }));
      resolve(plexus);
    };

    const onSync = (synced: boolean) => {
      if (!synced) return;
      handshake.off("sync", onSync);
      try {
        finish(DemoPlexus.connect(doc) as DemoPlexus);
      } catch {
        handshake.destroy();
        worker.port.close();
        resolve(localOnly());
      }
    };

    if (handshake.synced) {
      onSync(true);
      return;
    }

    handshake.on("sync", onSync);
    handshake.on("status", (event: { status: string }) => {
      if (event.status !== "sync-timeout") return;
      handshake.off("sync", onSync);
      handshake.destroy();
      worker.port.close();
      resolve(localOnly());
    });
  });
}
