# plexus-xyflow worker

Exemplary [`plexus-do`](../../../packages/plexus-do) host. The Worker names the
Durable Object and plants the Flow seed. That is the first writer — not an
authority. Browsers speak y-websocket and only `connect`.

```sh
pnpm --filter plexus-xyflow-worker --filter plexus-xyflow-demo --parallel dev
```

Vite (5174) proxies `/docs` to this process (8788).
