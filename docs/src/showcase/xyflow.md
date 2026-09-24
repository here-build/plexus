---
title: xyflow
description: React Flow's graph as a Plexus document. Nested groups own their children; a handoff is an edge that points across owners.
---

**xyflow did not know Plexus existed. That is the point.**

This showcase takes React Flow's graph — nodes, edges, subflows — and makes the graph itself a reactive, replicated Plexus model. It is not a collaboration-shaped rewrite of the canvas, and it is not a `Y.Map` of node JSON.

[Open the canvas](/xyflow/).

## What is modeled

<table>
<thead>
<tr>
<th>xyflow concept</th>
<th>Plexus representation</th>
</tr>
</thead>
<tbody>
<tr>
<td>Flow</td>
<td>Root model</td>
</tr>
<tr>
<td>Node</td>
<td>`FlowNode` — position, type, label</td>
</tr>
<tr>
<td>Edge</td>
<td>`FlowEdge` — points at two nodes</td>
</tr>
<tr>
<td>Subflow / `parentId`</td>
<td>Exclusive ownership (`children`)</td>
</tr>
<tr>
<td>Node registry</td>
<td>Synced `id → model` map</td>
</tr>
<tr>
<td>Viewport, `selected`</td>
<td>Local editor state</td>
</tr>
<tr>
<td>Cursor, remote selection</td>
<td>Reactive awareness</td>
</tr>
<tr>
<td>Undo / redo</td>
<td>Plexus document undo (`⌘Z`)</td>
</tr>
</tbody>
</table>

A group **owns** its children. An edge **points** at its ends. `selected`, `dragging`, `measured`, and the viewport stay on the client. `@xyflow/react` is a peer. It is not bundled or forked.

Drag a node onto a group to reparent it. **+ Group** wraps the selection. A live peer pane is the same room in a second client.

## This origin, and the socket

The canvas speaks y-websocket at `/docs` on the current host. A `plexus-do` Worker on that path is the first writer. GitHub Pages is a file server, so that warmup fails here; the demo then uses a `SharedWorker` (tabs in this browser share a graph) or a local document (this tab only). Two local bootstraps are two trees. The transport pill names which of those happened.

A missing `?room=` is written into the URL so the address is the invite.

Local full stack, including the Durable Object: `pnpm --filter plexus-xyflow-demo dev:all` from the repo.
