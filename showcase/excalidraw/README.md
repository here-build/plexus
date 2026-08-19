# Plexus + Excalidraw

**Excalidraw did not know Plexus existed. That is the point.**

This repository takes Excalidraw's existing scene model and makes the scene
itself a reactive, replicated Plexus model. It is not a collaboration-shaped
rewrite of Excalidraw, and it is not a `Y.Array` placed around an element list.
The original editor remains the editor; Plexus supplies the document model
underneath it.

Plexus began with a practical goal: add CRDT replication to an existing
MobX-driven model without maintaining one object graph for the application and
another for the wire. Making that convenient was the easy part. Making it sound
required stable object identity, ownership distinct from references, granular
collection operations, materialization, transactions, undo, and reactive
presence.

This integration is an attempt to falsify the result with a model Plexus did
not design and does not control.

> I didn't intend this to turn into a rant, but I've spent so much time trying
> to get it working over the years, and the gap between the toy “Look, it's
> magic!” demos and anything real is just so wide.
>
> — [Hacker News discussion](https://news.ycombinator.com/item?id=42743128)

## Why Excalidraw is a useful test

TodoMVC can show that values arrive on another client. It does not put much
pressure on the application model.

An Excalidraw document does:

- it has many concrete element types with different shapes;
- frames own children, while arrows only point at their ends;
- images refer to file records registered elsewhere in the scene;
- elements are continuously created, edited, moved, grouped, deleted, and
  restored;
- document state must remain separate from local camera state and ephemeral
  presence;
- the integration must preserve the real editor's React surface, callbacks,
  menus, and plugins.

These semantics were not invented for this repository. The integration has to
accommodate them.

The Excalidraw CRDT RFC
([#3537](https://github.com/excalidraw/excalidraw/issues/3537)) describes two
broad approaches: wrap the element array in a `Y.Array`, which does not resolve
concurrent edits to the same element, or make the scene itself the CRDT. This
repository implements the second approach.

## What is actually modeled

| Excalidraw concept                         | Plexus representation              |
| ------------------------------------------ | ---------------------------------- |
| Scene                                      | Root model                         |
| Rectangle, text, arrow, frame, image, etc. | Concrete TypeScript model classes  |
| Scene element registry                     | Synced `id → model` map            |
| Scene and frame children                   | Exclusive ownership                |
| Arrow bindings and other links             | Non-owning references              |
| Image data                                 | Referenced `ExcalidrawFile` models |
| Camera and local selection                 | Local editor state                 |
| Cursor, remote selection, name, avatar     | Reactive awareness fields          |
| Editor undo and redo                       | Plexus document undo and redo      |

`Scene.elements` is deliberately a `@syncing.map`, not the ownership tree. The
tree is expressed by `Scene.children` and each frame's `children`. A frame
**owns** its children; an arrow **points** at its ends. A line is not an arrow,
and a magic frame is not a frame.

Every materialized entity remains an ordinary class instance. The editor sees
Excalidraw-shaped objects while Plexus keeps their fields, collections,
identity, and relationships replicated through Yjs. `version` and
`versionNonce` are compatibility getters rather than the synchronization
mechanism.

## What remains Excalidraw

`@here.build/plexus-excalidraw` is a binding, not a replacement editor. It
re-exports Excalidraw's React surface, including `MainMenu`, `Footer`, sidebars,
and plugins. Children mount inside the real editor context, and normal
Excalidraw props and callbacks continue to work.

`@excalidraw/excalidraw` is a peer dependency. It is not bundled or forked.

The relevant proof is not merely that two canvases move together. It is that a
third-party editor can keep its own UI and public model semantics without an
application-maintained mirror between “local objects” and “CRDT objects.”

## The backend is the wire

The showcase Worker (`showcase/excalidraw/worker`) is a `plexus-do` host.
It names the Durable Object and plants the Scene seed — the first writer,
not an authority. Browsers speak y-websocket and only `connect`.

A `SharedWorker` remains the offline fallback when that host is down.
Two local bootstraps are two trees; do not treat the fallback as a second
first-writer in the same room.

Sync the `Y.Doc` first, then connect Plexus:

```tsx
import { Suspense, use } from "react";
import { Excalidraw, ExcalidrawPlexus } from "@here.build/plexus-excalidraw";

const ready = (async () => {
  await whenSynced(provider);
  return ExcalidrawPlexus.connect(doc);
})();

function Canvas() {
  const plexus = use(ready);
  return <Excalidraw plexus={plexus} />;
}

<Suspense fallback="connecting…">
  <Canvas />
</Suspense>;
```

The Worker calls `ExcalidrawPlexus.bootstrap(scene, guid, doc)` once, as
bytes, via `seed`. A warmed-up peer calls `ExcalidrawPlexus.connect(doc)`.
Replacing the host means replacing the provider setup, not the scene models
or editor binding.

## Packages

| Package                                | What it contains                                      |
| -------------------------------------- | ----------------------------------------------------- |
| `@here.build/plexus-excalidraw-models` | `Scene` and every Excalidraw document type as classes |
| `@here.build/plexus-excalidraw`        | Drop-in `<Excalidraw>` bound to a Plexus scene        |
| `plexus-excalidraw-demo`               | One canvas, y-websocket client, and presence UI       |
| `plexus-excalidraw-worker`             | plexus-do host — first writer, y-websocket, optional static UI |

For the underlying model API and the constraints that led to it, see
[`@here.build/plexus`](https://github.com/here-build/plexus/tree/main/packages/plexus).

## Develop

```bash
# from the plexus repo root
pnpm install
pnpm --filter "./showcase/excalidraw/**" test

# Worker (8787) + canvas (5173, proxies /docs → 8787). Same origin from the tab.
pnpm --filter plexus-excalidraw-demo dev:all
```

`?room=` picks the doc id (default `plexus-excalidraw`). Open another tab on
the same URL. `wrangler deploy` from the worker package serves the built
canvas and the sockets on one port.
