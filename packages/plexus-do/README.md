# @here.build/plexus-do

A **Worker draft** for Plexus/Yjs sync on Cloudflare Durable Objects — leader, archive follower, presence registry. It is not a Worker. Wrangler never deploys this package. A product becomes a Worker after it fills the holes the bases leave open and exports *that* class from its own entry.

**The host names the object. The object does not name itself.** Cloudflare does not expose `idFromName` to the leader interior (`ctx.id.name` is empty). Identity crosses the actor boundary via `seed`. Authorization is the other required hole: `authorizeWebSocket` is abstract, and a missing implementation is a TypeScript error, not a README note.

`yjs` / `lib0` / `y-protocols` are dependencies so the isolate bundles one copy. Types come from `wrangler types`, not a `@cloudflare/workers-types` peer. No Hono — `handleHttp` is a `Request` → `Response | null`.

[FSL-1.1-MIT](./LICENSE.md).

## Specifiers

| Import | Ships |
|---|---|
| `@here.build/plexus-do/leader` | `PlexusLeaderSyncDO` |
| `@here.build/plexus-do/archive` | `PlexusArchiveSyncDO` |
| `@here.build/plexus-do/presence` | `EphemeralRegistryDO` |
| `@here.build/plexus-do/client` | `mirrorSyncDoc` — Worker-to-Worker replica, not a browser provider |
| `@here.build/plexus-do` | types, wire constants, errors |

`persist` / `protocol` / `follower` / `spill` are internals. Do not import them. Classes are not on `.` — use the specifier.

Runnable Workers live in [`examples/`](./examples): `bare` is fetch-only; `hono-workos` is the host-stamp flow with WorkOS `org_id === doc id`.

The `class_name` in wrangler is the **product** class. Never bind `PlexusLeaderSyncDO` — `abstract` is erased, deploy succeeds, the first handshake throws.

New namespaces use SQLite. Persist talks the KV *API*, which SQLite-backed DOs still implement. Do not use `legacy-kv` / `new_classes`.

## Recipe — minimum Worker

```ts
// src/index.ts
import { PlexusLeaderSyncDO, type WebSocketHandshakeResult } from "@here.build/plexus-do/leader";

export interface Env {
  DOC_LEADER: DurableObjectNamespace<DocLeader>;
}

export class DocLeader extends PlexusLeaderSyncDO<Env> {
  protected override async authorizeWebSocket(request: Request): Promise<WebSocketHandshakeResult | null> {
    const userId = await identify(request, this.env);
    if (!userId) return null;
    return { attachment: { userId } };
  }

  protected override async handleHttp() {
    return null; // base answers 426
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const docId = url.searchParams.get("doc") ?? url.pathname.slice(1);
    if (!docId) return new Response("missing doc id", { status: 400 });
    const stub = env.DOC_LEADER.get(env.DOC_LEADER.idFromName(docId));
    return stub.fetch(request);
  },
};

async function identify(_request: Request, _env: Env): Promise<string | null> {
  return null; // replace with a recipe below
}
```

```jsonc
// wrangler.jsonc
{
  "name": "my-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "durable_objects": {
    "bindings": [{ "name": "DOC_LEADER", "class_name": "DocLeader" }],
  },
  "exports": {
    "DocLeader": { "type": "durable-object", "storage": "sqlite" },
  },
}
```

```sh
npx wrangler types
npx wrangler deploy
```

Forward the **raw** request (`stub.fetch(request)`). The upgrade headers — and any cookie or Access JWT on them — have to reach `authorizeWebSocket`. Do not reconstruct a new `Request` and drop them.

## Recipe — host names the object

A leader does not know its external id until the host tells it. First touch is `seed`, from the Worker that already resolved the name (insert a row, mint an id, then address):

```ts
const id = env.DOC_LEADER.idFromName(docId);
const stub = env.DOC_LEADER.get(id);
await stub.seed(docId, yjsState);
```

`seed` persists `entityId` and the prime bytes, then optionally seeds the archive follower. Later lives rehydrate both from storage. Calling `idFromName` alone does not write the name into the object.

Sibling actors (archive, presence) are addressed the same way — from the host, or from a leader that *already* has `entityId`:

```ts
protected override archiveFollower(entityId: string) {
  return this.env.DOC_ARCHIVE.get(this.env.DOC_ARCHIVE.idFromName(entityId));
}
```

The archive *can* read `ctx.id.name` (that namespace is created via `idFromName`). The leader cannot. Do not unify the two identity hooks.

A `/:id` → `idFromName(id)` → accept-any-websocket helper does not belong in this package. Room naming, the row, and first-touch `seed` are host work.

## Recipe — authorize the handshake

`authorizeWebSocket` is the only gate. Return `null` → 401. Return `{ attachment }` → the base accepts the socket, serializes the attachment (keep it small — Durable Object attachments are a 2 KiB class), and sends sync step1.

Browsers cannot set `Authorization` on `new WebSocket`. The token has to arrive as a **cookie**, as a header **Cloudflare injects**, or as a **query param** the client is allowed to put on the URL. Verifying inside the DO is the default: the hook runs even if something other than your Worker reaches the stub.

Three stacks collapse to that hook. Pick one.

### Cloudflare Access

The Cloudflare-native gate. Not a user-management product — Zero Trust in front of the Worker. Access puts `Cf-Access-Jwt-Assertion` on the request; forwarding the raw upgrade preserves it. Verify the JWT. Do not trust the header without a signature check ([Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksByTeam.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, set);
  }
  return set;
}

protected override async authorizeWebSocket(request: Request) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks(this.env.TEAM_DOMAIN), {
      issuer: this.env.TEAM_DOMAIN,
      audience: this.env.POLICY_AUD,
    });
    const userId = typeof payload.email === "string" ? payload.email : payload.sub;
    if (!userId) return null;
    return { attachment: { userId } };
  } catch {
    return null;
  }
}
```

`TEAM_DOMAIN` is `https://<team>.cloudflareaccess.com`. `POLICY_AUD` is the Access application audience tag. Fetch JWKS from the team endpoint — Access rotates signing keys every six weeks.

Use this when the Worker is already behind Access (internal studio, Zero Trust). It does not create users, sessions, or SSO for a public app.

### Better Auth

The Hono + Workers default. Session lives in a cookie; `getSession` reads the same headers the browser sent on the upgrade. Construct the Better Auth instance from `env` the same way the Worker’s `/api/auth/*` handler does ([Better Auth on Cloudflare](https://hono.dev/examples/better-auth-on-cloudflare)).

```ts
protected override async authorizeWebSocket(request: Request) {
  const session = await auth(this.env).api.getSession({ headers: request.headers });
  if (!session) return null;
  return { attachment: { userId: session.user.id } };
}
```

Same-origin only, unless you have configured the cookie for the WebSocket URL’s host. Cross-origin tabs need a query token or the host-stamp recipe below.

### WorkOS AuthKit

The vendor Cloudflare’s own Workers/MCP demos pair with. AuthKit’s access token is a JWT; verify it against the WorkOS JWKS ([session tokens](https://workos.com/docs/authkit/sessions)). Cookie on same-origin. Cross-origin WebSocket: put the access token on the query string — browsers still cannot set `Authorization`.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const workosJwks = (clientId: string) =>
  createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));

protected override async authorizeWebSocket(request: Request) {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("access_token") ??
    cookie(request, "wos-session"); // or whatever name AuthKit sealed the session under
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, workosJwks(this.env.WORKOS_CLIENT_ID), {
      issuer: this.env.WORKOS_ISSUER ?? "https://api.workos.com/",
    });
    if (typeof payload.sub !== "string") return null;
    return {
      attachment: {
        userId: payload.sub,
        orgId: typeof payload.org_id === "string" ? payload.org_id : undefined,
        role: typeof payload.role === "string" ? payload.role : undefined,
      },
    };
  } catch {
    return null;
  }
}
```

Use this when you already bought AuthKit (SSO, directory sync, audit). `@cloudflare/workers-oauth-provider` is the other Cloudflare-adjacent name: it makes *your* Worker an OAuth *server* (MCP). That is not this hole.

### Host already authenticated

The Worker is the trust boundary. It resolves the session, then forwards a header the DO treats as fact. Only correct if every path to the stub goes through that Worker — strip the header from anything that arrived from the public internet, then set it yourself.

```ts
// Worker
const session = await resolveSession(request, env);
if (!session) return new Response("Unauthorized", { status: 401 });
const headers = new Headers(request.headers);
headers.delete("x-internal-user-id");
headers.set("x-internal-user-id", session.userId);
return stub.fetch(new Request(request, { headers }));

// DocLeader
protected override async authorizeWebSocket(request: Request) {
  const userId = request.headers.get("x-internal-user-id");
  if (!userId) return null;
  return { attachment: { userId } };
}
```

Grants that must not change mid-socket (read-only, a comments lane) resolve here, once, into the attachment. Role changes take a reconnect.

## Recipe — HTTP inside the DO

`handleHttp` is abstract so the product can serve its own HTTP. `return null` is a finished answer — the base returns 426. When the DO *does* speak HTTP (snapshots, admin), return a `Response`. The router is yours; this package does not ship one.

```ts
protected override async handleHttp(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/snapshot") {
    return new Response(Y.encodeStateAsUpdate(this.doc));
  }
  return null;
}
```

## Recipe — archive + read-only

Archive is optional. Bind a second class, point `archiveFollower` at it, provision SQLite the same way. `entityId()` on the archive is `this.ctx.id.name` (or a test fallback). The leader pushes diffs on the persist alarm and will not advance the archive if a hot write failed.

Read-only is a hook, not a protocol:

```ts
protected override isReadOnlyConnection(ws: WebSocket) {
  return Boolean((ws.deserializeAttachment() as { readOnly?: boolean } | null)?.readOnly);
}
```

Catch-up still runs. Inbound step2 / update is dropped before the doc.

`mirrorSyncDoc` (`./client`) opens an internal WebSocket to a finished leader and mirrors it into a local `Y.Doc`. It is a Worker-side actor (a runner DO), not a browser provider. Browsers stay on y-websocket.

## Status

0.9 — the draft is the product used in production. The public specifiers above are the surface. Compatibility date floor: `2026-08-01` (`cloudflare:workers` `DurableObject`).
