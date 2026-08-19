/**
 * Exemplary plexus-do host for the Excalidraw showcase.
 *
 * The Worker names the object and plants the Scene seed. That is the first
 * writer — not an authority, not a leader after the write. Browsers only
 * `connect`. `?user=` stamps the socket attachment. That is not auth.
 */

import { PlexusLeaderSyncDO, type WebSocketHandshakeResult } from "@here.build/plexus-do/leader";
import type { PlexusSyncEnv } from "@here.build/plexus-do";

import { encodeSceneSeed } from "./scene-seed.js";

export interface Env extends PlexusSyncEnv {
  DOC_LEADER: DurableObjectNamespace<DocLeader>;
  ASSETS?: Fetcher;
}

export class DocLeader extends PlexusLeaderSyncDO<Env> {
  protected override async authorizeWebSocket(request: Request): Promise<WebSocketHandshakeResult | null> {
    const userId = new URL(request.url).searchParams.get("user");
    if (!userId) return null;
    return { attachment: { userId } };
  }

  protected override async handleHttp(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname === "/snapshot") {
      const snap = await this.getSnapshot();
      return new Response(snap.buffer as ArrayBuffer, {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/docs\/([^/]+)(?:\/(ws|snapshot|seed))?$/.exec(url.pathname);
    if (!match) {
      return env.ASSETS?.fetch(request) ?? new Response("usage: /docs/:docId{/ws|/snapshot|/seed}", { status: 404 });
    }

    const docId = decodeURIComponent(match[1]!);
    const action = match[2] ?? "snapshot";
    const stub = env.DOC_LEADER.get(env.DOC_LEADER.idFromName(docId));

    if (action === "seed" && request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      await stub.seed(docId, body.byteLength > 0 ? body : encodeSceneSeed(docId));
      return new Response(null, { status: 204 });
    }

    await ensureNamed(stub, docId);

    if (action === "ws") return stub.fetch(request);

    const inner = new URL(request.url);
    inner.pathname = "/snapshot";
    return stub.fetch(new Request(inner, request));
  },
};

/** First touch writes `entityId` and the Scene. Skip once the prime doc has content. */
async function ensureNamed(stub: DurableObjectStub<DocLeader>, docId: string): Promise<void> {
  const snap = await stub.getSnapshot();
  if (snap.byteLength > 2) return;
  await stub.seed(docId, encodeSceneSeed(docId));
}
