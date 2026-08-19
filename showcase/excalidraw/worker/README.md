# plexus-excalidraw worker

Exemplary [`plexus-do`](../../../packages/plexus-do) host. The Worker names the
Durable Object and plants the Scene seed. That is the first writer — not an
authority. Browsers speak y-websocket and only `connect`.

`?user=` stamps the socket attachment. That is not auth.

```
GET  /docs/:room/ws?user=ada   # y-websocket
GET  /docs/:room/snapshot
POST /docs/:room/seed          # optional raw yjs bytes; empty body = default Scene
```

```sh
# from the plexus repo root
pnpm --filter plexus-excalidraw-worker --filter plexus-excalidraw-demo --parallel dev
```

Vite (5173) proxies `/docs` to this process (8787). After `vite build`,
`pnpm deploy` serves the canvas and the sockets on one Worker port.
