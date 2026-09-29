---
title: Excalidraw
description: Excalidraw's scene as a Plexus graph. The original editor remains the editor.
---

Excalidraw's scene becomes a reactive, replicated Plexus graph: frames own shapes, arrows reference their endpoints, and images refer to file records. The integration keeps the existing editor surface.

[Open the canvas](/excalidraw/).

## Try this

1. Open the canvas and check its transport indicator.
2. Open the same room URL in another tab when SharedWorker or WebSocket transport is active.
3. Add a shape in one client and edit it in the other. Watch the scene update.
4. Put shapes inside a frame and move them between frames. The example models those relationships as ownership; arrow bindings remain references.

**On GitHub Pages:** SharedWorker transport shares state within the same browser. Local mode is limited to one client. To collaborate across devices, run the WebSocket stack described below.

## Why this is a useful test

TodoMVC can show that values arrive on another client. It does not put much pressure on the application model. An Excalidraw document does: many concrete element types; frames own children while arrows only point; images refer to file records; the editor's React surface stays the editor.

The Excalidraw CRDT RFC ([#3537](https://github.com/excalidraw/excalidraw/issues/3537)) describes two approaches: wrap the element array in a `Y.Array`, which does not resolve concurrent edits to the same element, or make the scene itself the CRDT. This canvas is the second.

## What is modeled

| Excalidraw concept | Plexus representation |
| --- | --- |
| Scene | Root model |
| Rectangle, text, arrow, frame, image, … | Concrete TypeScript classes |
| Scene element registry | Synced `id → model` map |
| Scene and frame children | Exclusive ownership |
| Arrow bindings | Non-owning references |
| Camera and local selection | Local editor state |
| Cursor, remote selection, name, avatar | Reactive awareness |
| Editor undo and redo | Plexus document undo |

`@excalidraw/excalidraw` is a peer. It is not bundled or forked.

A live peer pane is the same room in a second client.

## Run with a sync server

The canvas speaks y-websocket at `/docs` on the current host. A `plexus-do` Worker on that path is the first writer. GitHub Pages is a file server, so that warmup fails here; the demo then uses a `SharedWorker` (tabs in this browser share a scene) or a local document (this tab only). Two local bootstraps are two trees. The transport pill names which of those happened.

A missing `?room=` is written into the URL so the address is the invite.

Local full stack, including the Durable Object: `pnpm --filter plexus-excalidraw-demo dev:all` from the repo.

## Read the model

See [Ownership and references](/guide/ownership/) for the rules behind these relationships, and [Presence and awareness](/guide/awareness/) for cursors and selections.
