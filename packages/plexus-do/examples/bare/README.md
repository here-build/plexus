# bare Worker

Fetch-only host. No Hono. No IdP. `?user=` is the attachment identity — anyone who can reach the Worker can pick a name.

```sh
pnpm dev
```

```
POST /docs/room-1/seed          # empty Y.Doc, or raw yjs bytes as the body
GET  /docs/room-1/ws?user=ada   # y-websocket
GET  /docs/room-1/snapshot
```

The host calls `idFromName` and `seed`. The class exported here is `DocLeader` — that is the wrangler `class_name`.
