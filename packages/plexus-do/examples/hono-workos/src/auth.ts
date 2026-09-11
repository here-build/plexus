/**
 * Host-side identity.
 *
 * Same split as a production Worker: the edge verifies tokens, strips any
 * inbound `x-internal-*`, and stamps its own. The DO never talks to WorkOS.
 *
 * Access control is one equality: WorkOS `org_id` === doc id. A user without
 * an organization on the token cannot open a room.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { Env } from "./env.js";

const workosJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(cache: Map<string, ReturnType<typeof createRemoteJWKSet>>, url: string) {
  let set = cache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    cache.set(url, set);
  }
  return set;
}

export interface Session {
  userId: string;
  orgId: string;
}

/** Optional Cloudflare Access gate. No-op when TEAM_DOMAIN is unset. */
export async function requireAccess(request: Request, env: Env): Promise<Response | null> {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return new Response("missing Access JWT", { status: 403 });
  try {
    await jwtVerify(token, jwks(accessJwks, `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`), {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });
    return null;
  } catch {
    return new Response("invalid Access JWT", { status: 403 });
  }
}

export async function verifyWorkos(request: Request, env: Env): Promise<Session | null> {
  if (!env.WORKOS_CLIENT_ID) return null;
  const url = new URL(request.url);
  const token =
    bearer(request) ?? url.searchParams.get("access_token") ?? cookie(request, "wos-access-token");
  if (!token) return null;

  const issuer =
    env.WORKOS_ISSUER ||
    `https://api.workos.com/user_management/${env.WORKOS_CLIENT_ID}`;

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks(workosJwks, `https://api.workos.com/sso/jwks/${env.WORKOS_CLIENT_ID}`), {
      issuer: [issuer, "https://api.workos.com/"],
    }));
  } catch {
    return null;
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const orgId = typeof payload.org_id === "string" ? payload.org_id : null;
  if (!userId || !orgId) return null;
  return { userId, orgId };
}

/** Doc id is the WorkOS org. Anything else is 403. */
export function assertOrgOwnsDoc(session: Session, docId: string): boolean {
  return session.orgId === docId;
}

/**
 * Copy the inbound request (keeps Upgrade + cookies) and replace internal
 * headers. The DO trusts only what this function writes.
 */
export function stampInternal(request: Request, session: Session): Request {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("x-internal-")) headers.delete(key);
  }
  headers.set("x-internal-user-id", session.userId);
  headers.set("x-internal-org-id", session.orgId);
  return new Request(request, { headers });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return decodeURIComponent(trimmed.slice(name.length + 1));
  }
  return null;
}
