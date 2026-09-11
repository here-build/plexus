import { WebsocketProvider } from "y-websocket";
import { YMessagePortProvider } from "@here.build/y-messageport";
import generateSillyName from "sillyname";
import * as Y from "yjs";

import { DEFAULT_ROOM, bindRoom } from "../room.js";
import { defaultRoot } from "../seed.js";
import { isPeerView } from "../view.js";
import { DemoPlexus } from "./DemoPlexus.js";

const attachments = new Set<{ destroy(): void }>();

const WARMUP_MS = 2000;

export type Transport = "durable-object" | "shared-worker" | "local";

export type ConnectedFlow = {
  plexus: DemoPlexus;
  transport: Transport;
  room: string;
};

function roomId(): string {
  if (typeof location === "undefined") return DEFAULT_ROOM;
  return bindRoom(location, (url) => history.replaceState(null, "", url));
}

function userId(): string {
  if (typeof sessionStorage === "undefined") return generateSillyName();
  const peer = typeof location !== "undefined" && isPeerView(location.search);
  const key = peer ? "plexus-xyflow-user-peer" : "plexus-xyflow-user";
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

function localOnly(room: string): ConnectedFlow {
  const plexus = DemoPlexus.bootstrap(defaultRoot(), room) as DemoPlexus;
  claimName(plexus);
  return { plexus, transport: "local", room };
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
 * Local bootstrap is a last resort and a different document — the UI must
 * say so. Two `local` tabs on the same URL do not share a graph.
 */
export function connectFlow(): Promise<ConnectedFlow> {
  if (typeof location === "undefined") {
    return Promise.resolve(localOnly(DEFAULT_ROOM));
  }

  const room = roomId();
  const user = userId();
  const doc = new Y.Doc({ guid: room });
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const serverUrl = `${proto}//${location.host}/docs`;
  const path = `${room}/ws`;

  const warmup = new WebsocketProvider(serverUrl, path, doc, { params: { user } });

  return waitSynced(warmup, WARMUP_MS).then((ok) => {
    const dropWarmup = () => {
      try {
        warmup.destroy();
      } catch {
        /* y-websocket can throw on a half-applied dual-yjs doc */
      }
    };
    if (!ok) {
      dropWarmup();
      return sharedWorkerOrLocal(doc, room);
    }
    try {
      const plexus = DemoPlexus.connect(doc) as DemoPlexus;
      void plexus.root.children.length;
      claimName(plexus);
      dropWarmup();
      bindAwareness(doc, serverUrl, path, user, plexus);
      return { plexus, transport: "durable-object", room };
    } catch {
      dropWarmup();
      return sharedWorkerOrLocal(doc, room);
    }
  });
}

function sharedWorkerOrLocal(failedDoc: Y.Doc, room: string): Promise<ConnectedFlow> {
  try {
    failedDoc.destroy();
  } catch {
    /* same dual-yjs destroy trap as warmup */
  }
  if (typeof SharedWorker === "undefined") {
    return Promise.resolve(localOnly(room));
  }

  const doc = new Y.Doc({ guid: room });
  const worker = new SharedWorker(new URL("./flow.worker.ts", import.meta.url), {
    type: "module",
    name: `plexus-xyflow-flow:${room}`,
  });
  const handshake = new YMessagePortProvider(doc, worker.port);

  return new Promise((resolve) => {
    const finish = (plexus: DemoPlexus) => {
      claimName(plexus);
      handshake.destroy();
      attachments.add(new YMessagePortProvider(doc, worker.port, { awareness: plexus.awareness }));
      resolve({ plexus, transport: "shared-worker", room });
    };

    const onSync = (synced: boolean) => {
      if (!synced) return;
      handshake.off("sync", onSync);
      try {
        finish(DemoPlexus.connect(doc) as DemoPlexus);
      } catch {
        handshake.destroy();
        worker.port.close();
        resolve(localOnly(room));
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
      resolve(localOnly(room));
    });
  });
}
