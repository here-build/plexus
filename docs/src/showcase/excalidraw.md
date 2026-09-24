---
title: Excalidraw
description: Excalidraw's scene as a Plexus graph. The original editor remains the editor.
---

**Excalidraw did not know Plexus existed. That is the point.**

This showcase takes Excalidraw's existing scene model and makes the scene itself a reactive, replicated Plexus model. It is not a collaboration-shaped rewrite of Excalidraw, and it is not a `Y.Array` placed around an element list.

[Open the canvas](/excalidraw/).

## Why this is a useful test

TodoMVC can show that values arrive on another client. It does not put much pressure on the application model. An Excalidraw document does: many concrete element types; frames own children while arrows only point; images refer to file records; the editor's React surface stays the editor.

The Excalidraw CRDT RFC ([#3537](https://github.com/excalidraw/excalidraw/issues/3537)) describes two approaches: wrap the element array in a `Y.Array`, which does not resolve concurrent edits to the same element, or make the scene itself the CRDT. This canvas is the second.

## What is modeled

<table>
<thead>
<tr>
<th>Excalidraw concept</th>
<th>Plexus representation</th>
</tr>
</thead>
<tbody>
<tr>
<td>Scene</td>
<td>Root model</td>
</tr>
<tr>
<td>Rectangle, text, arrow, frame, image, …</td>
<td>Concrete TypeScript classes</td>
</tr>
<tr>
<td>Scene element registry</td>
<td>Synced `id → model` map</td>
</tr>
<tr>
<td>Scene and frame children</td>
<td>Exclusive ownership</td>
</tr>
<tr>
<td>Arrow bindings</td>
<td>Non-owning references</td>
</tr>
<tr>
<td>Camera and local selection</td>
<td>Local editor state</td>
</tr>
<tr>
<td>Cursor, remote selection, name, avatar</td>
<td>Reactive awareness</td>
</tr>
<tr>
<td>Editor undo and redo</td>
<td>Plexus document undo</td>
</tr>
</tbody>
</table>

`@excalidraw/excalidraw` is a peer. It is not bundled or forked.

A live peer pane is the same room in a second client.

## This origin, and the socket

The canvas speaks y-websocket at `/docs` on the current host. A `plexus-do` Worker on that path is the first writer. GitHub Pages is a file server, so that warmup fails here; the demo then uses a `SharedWorker` (tabs in this browser share a scene) or a local document (this tab only). Two local bootstraps are two trees. The transport pill names which of those happened.

A missing `?room=` is written into the URL so the address is the invite.

Local full stack, including the Durable Object: `pnpm --filter plexus-excalidraw-demo dev:all` from the repo.
