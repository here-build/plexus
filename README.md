# plexus

Reactive state management with automatic replication. Plexus lets you write
plain TypeScript classes and get collaborative, offline-tolerant, undoable
state for free: entities sync across clients over the most widely deployed JS
CRDT protocol (Yjs), with full MobX reactivity, entity-scoped history, and
CRDT-native identity (no id generators, no coordination).

## Packages

- **`plexus`** — the core: `PlexusModel` classes, decorators, typed field
  proxies (maps/sets/arrays/typed arrays), ownership + cycle prevention,
  entity-scoped undo/redo, awareness, telemetry, CRDT-native UUIDs.
  See `packages/plexus/README.md`.
- **`plexus-mobx-awareness`** — MobX reactive lens over `PlexusAwareness`
  (presence state as observables). Optional peer of core.
- **`hono-plexus-do`** — the sync server as a Cloudflare Durable Object:
  leader/follower lanes, persistence, presence, spill, archive sync.
  (FSL-1.1-MIT; the rest of the family is MIT.)
- **`plexus-vfs`** — a filesystem model over plexus entities (dirs, files,
  entity paths).
- **`y-messageport`** — Yjs sync + awareness Provider over anything that
  quacks like a `MessagePort` (workers, shared workers, cross-frame).
- **`y-control-channel`** — port-routing control plane `y-messageport`
  composes with: per-resource `MessageChannel` allocation and small control
  messages. Yjs-agnostic.

## Install

```bash
pnpm add @here.build/plexus yjs mobx
# optional:
pnpm add @here.build/plexus-mobx-awareness
pnpm add @here.build/y-messageport @here.build/y-control-channel
pnpm add @here.build/hono-plexus-do   # Cloudflare DO sync server
pnpm add @here.build/plexus-vfs
```

Peer dependencies: `yjs`, `y-protocols`, and `mobx` (see each package).

Floor packages from [@here.build/commons](https://github.com/here-build/commons)
(`collections`, `arrival-env`, `chunked-websocket`, `error-invariant`,
`tsconfig`, `eslint-configs`) are ordinary semver dependencies on npm.

## Repository shape

Standalone pnpm/turbo workspace. Also embedded in a private product monorepo
via git subtree for multi-product development. This repository is the home
for standalone use and review.

## License

[MIT](./LICENSE.md), except `packages/hono-plexus-do` which is
[FSL-1.1-MIT](./packages/hono-plexus-do/LICENSE.md).
