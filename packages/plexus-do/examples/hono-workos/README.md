# Hono + WorkOS

The host is the trust boundary. The DO only reads `x-internal-*` headers this Worker writes.

**Access control:** WorkOS `org_id` **is** the doc id. A token for org `org_01ABC` opens `/docs/org_01ABC/ws` and nothing else. Sign in through AuthKit with an organization selected — a token without `org_id` is 401.

Optional Cloudflare Access: set `TEAM_DOMAIN` and `POLICY_AUD`. The Worker then requires a valid `Cf-Access-Jwt-Assertion` *and* the WorkOS token.

```sh
cp .dev.vars.example .dev.vars   # fill WORKOS_CLIENT_ID
pnpm dev
```

```
GET /docs/${ORG_ID}/ws?access_token=${JWT}
GET /docs/${ORG_ID}/snapshot
    Authorization: Bearer ${JWT}
POST /docs/${ORG_ID}/seed
```

Inbound `x-internal-*` is stripped before the stamp. Do not point a browser `WebSocket` at this URL with an `Authorization` header — it cannot send one. Use the query token.
