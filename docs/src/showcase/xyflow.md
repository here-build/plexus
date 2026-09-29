---
title: React Flow
description: Explore a shared graph whose groups own nodes and whose edges reference their endpoints.
---

React Flow's nodes, edges, and subflows become a Plexus graph. Groups own their nodes; edges reference their endpoints. Viewport and selection state stay local to each editor.

[Open the canvas](/xyflow/).

## Try this

1. Open the canvas and check its transport indicator.
2. Open the same room URL in another tab when SharedWorker or WebSocket transport is active.
3. Edit a node's label and watch the other client update.
4. Drag a node onto a group to reparent it, or use **+ Group** to wrap a selection. Edges keep referencing their endpoints.

**On GitHub Pages:** SharedWorker transport shares state within the same browser. Local mode is limited to one client. To collaborate across devices, run the WebSocket stack described below.

## What is modeled

| xyflow concept | Plexus representation |
| --- | --- |
| Flow | Root model |
| Node | `FlowNode` — position, type, label |
| Edge | `FlowEdge` — points at two nodes |
| Subflow / `parentId` | Exclusive ownership (`children`) |
| Node registry | Synced `id → model` map |
| Viewport, `selected` | Local editor state |
| Cursor, remote selection | Reactive awareness |
| Undo / redo | Plexus document undo (`⌘Z`) |

A group **owns** its children. An edge **points** at its ends. `selected`, `dragging`, `measured`, and the viewport stay on the client. `@xyflow/react` is a peer. It is not bundled or forked.

Drag a node onto a group to reparent it. **+ Group** wraps the selection. A live peer pane is the same room in a second client.

## Run with a sync server

The canvas speaks y-websocket at `/docs` on the current host. A `plexus-do` Worker on that path is the first writer. GitHub Pages is a file server, so that warmup fails here; the demo then uses a `SharedWorker` (tabs in this browser share a graph) or a local document (this tab only). Two local bootstraps are two trees. The transport pill names which of those happened.

A missing `?room=` is written into the URL so the address is the invite.

Local full stack, including the Durable Object: `pnpm --filter plexus-xyflow-demo dev:all` from the repo.

## Read the model

See [Ownership and references](/guide/ownership/) for the rules behind these relationships, and [Presence and awareness](/guide/awareness/) for cursors and selections.
