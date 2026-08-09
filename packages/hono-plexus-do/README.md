# @here.build/hono-plexus-do

Cloudflare Durable Object sync server for Plexus/Yjs documents: leader +
follower lanes, persistence, presence registry, spill to R2, and archive sync.

```ts
import { LeaderSyncDO } from "@here.build/hono-plexus-do/leader";
// or ArchiveSyncDO, presence helpers, client mirror helpers — see package exports
```

Peer: `hono`. Depends on `@here.build/chunked-websocket` and
`@here.build/error-invariant` from npm.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License.
