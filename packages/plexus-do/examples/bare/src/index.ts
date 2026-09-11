/**
 * Bare host — no Hono, no IdP.
 *
 * The Worker names the object (`idFromName`) and seeds it. Identity is the
 * `user` query value stamped onto the socket attachment. That is not auth.
 */

import { PlexusLeaderSyncDO, type WebSocketHandshakeResult } from "@here.build/plexus-do/leader";
import type { PlexusSyncEnv } from "@here.build/plexus-do";
import * as Y from "yjs";

export interface Env extends PlexusSyncEnv {
  DOC_LEADER: DurableObjectNamespace<DocLeader>;
}

export class DocLeader extends PlexusLeaderSyncDO<Env> {
  protected override async authorizeWebSocket(request: Request): Promise<WebSocketHandshakeResult | null> {
    const userId = new URL(request.url).searchParams.get("user");
    if (!userId) return null;
    return { attachment: { userId } };
  }

  protected override async handleHttp(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname === "/snapshot") {
      return new Response(await this.getSnapshot());
    }
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/docs\/([^/]+)(?:\/(ws|snapshot|seed))?$/.exec(url.pathname);
    if (!match) return new Response("usage: /docs/:docId{/ws|/snapshot|/seed}", { status: 404 });

    const docId = decodeURIComponent(match[1]!);
    const action = match[2] ?? "snapshot";
    const stub = env.DOC_LEADER.get(env.DOC_LEADER.idFromName(docId));

    if (action === "seed" && request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      const bytes = body.byteLength > 0 ? body : Y.encodeStateAsUpdate(new Y.Doc());
      await stub.seed(docId, bytes);
      return new Response(null, { status: 204 });
    }

    await ensureNamed(stub, docId);

    if (action === "ws") return stub.fetch(request);

    const inner = new URL(request.url);
    inner.pathname = "/snapshot";
    return stub.fetch(new Request(inner, request));
  },
};

/** First touch writes `entityId`. Skip once the prime doc has content. */
async function ensureNamed(stub: DurableObjectStub<DocLeader>, docId: string): Promise<void> {
  const snap = await stub.getSnapshot();
  if (snap.byteLength > 2) return;
  await stub.seed(docId, snap.byteLength > 0 ? snap : Y.encodeStateAsUpdate(new Y.Doc()));
}
