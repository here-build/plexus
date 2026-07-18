# plexus

Reactive state management with automatic replication. Plexus lets you write
plain TypeScript classes and get collaborative, offline-tolerant, undoable
state for free: entities sync across clients over the most widely deployed JS
CRDT protocol (Yjs), with full MobX reactivity, entity-scoped history, and
CRDT-native identity (no id generators, no coordination).

## Packages

- `plexus` — the core: `PlexusModel` classes, decorators, typed field
  proxies (maps/sets/arrays/typed arrays), ownership + cycle prevention,
  entity-scoped undo/redo, awareness, telemetry, CRDT-native UUIDs.
  See `packages/plexus/README.md`.
- `hono-plexus-do` — the sync server as a Cloudflare Durable Object:
  leader/follower lanes, persistence, presence, spill, archive sync.
- `plexus-vfs` — a filesystem model over plexus entities (dirs, files,
  entity paths) — the VFS other tools mount.
- `y-messageport` — the client-side transport: Yjs sync + awareness
  Provider over anything that quacks like a `MessagePort` (workers,
  shared workers, cross-frame channels).
- `y-control-channel` — the port-routing control plane `y-messageport`
  composes with: per-resource `MessageChannel` allocation and small
  control messages. Yjs-agnostic.

More members arrive as they mature (the rich-text cluster —
Peritext-over-Yjs — is staged in the parent monorepo's experimental tier).

## Repository shape

A standalone pnpm/turbo workspace, and simultaneously an embedded directory
of the here.build product monorepo where day-to-day development happens.
History is real development history, including the AI-collaboration
co-author trailers.

## License

[Functional Source License, Version 1.1, MIT Future License](./LICENSE.md).
