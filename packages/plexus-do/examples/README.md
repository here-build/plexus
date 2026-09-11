# plexus-do examples

Two finished Workers. The package is the draft; these files are the deployable.
They live under `packages/plexus-do` and inherit [FSL-1.1-MIT](../LICENSE.md).

| Folder | Host | Auth |
|---|---|---|
| [`bare`](./bare) | `fetch` only | `?user=` stamps identity. Not an IdP. |
| [`hono-workos`](./hono-workos) | Hono | WorkOS access token. **Access control:** JWT `org_id` must equal the doc id. Optional Cloudflare Access JWT in front. |

Both export a concrete `DocLeader`, bind it under that name, and `seed` from the host — the object does not name itself.

```sh
pnpm install   # from the plexus repo root
cd packages/plexus-do/examples/bare && pnpm dev
```
