import { PlexusLeaderSyncDO, type WebSocketHandshakeResult } from "@here.build/plexus-do/leader";

import type { Env } from "./env.js";

/**
 * Trusts only headers the host stamped. Does not verify WorkOS.
 * `org_id === doc id` is enforced again if `entityId` is already known.
 */
export class DocLeader extends PlexusLeaderSyncDO<Env> {
  protected override async authorizeWebSocket(request: Request): Promise<WebSocketHandshakeResult | null> {
    const userId = request.headers.get("x-internal-user-id");
    const orgId = request.headers.get("x-internal-org-id");
    if (!userId || !orgId) return null;

    const known = this.entityId();
    if (known && known !== orgId) return null;

    const requestedProtocol = request.headers.get("Sec-WebSocket-Protocol");
    return {
      attachment: { userId, orgId },
      responseHeaders: requestedProtocol ? { "Sec-WebSocket-Protocol": requestedProtocol } : undefined,
    };
  }

  protected override async handleHttp(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname === "/snapshot") {
      return new Response(await this.getSnapshot());
    }
    return null;
  }
}
