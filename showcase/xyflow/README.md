# Plexus + xyflow

**xyflow did not know Plexus existed. That is the point.**

This showcase takes React Flow's graph — nodes, edges, subflows — and makes
the graph itself a reactive, replicated Plexus model. It is not a
collaboration-shaped rewrite of the canvas, and it is not a `Y.Map` of node
JSON. The original `<ReactFlow>` remains the view; Plexus supplies the
document underneath it.

`@xyflow/react` is a peer. It is not bundled or forked.

The canvas is the argument. Nested groups own their children; **handoff** is
an edge that points across owners. Drag a node onto a group to reparent it.
**+ Group** wraps the selection. A live peer pane is the same room in a
second client — cursors and rings show up without opening a tab. `selected`
stays local. The transport pill names the wire, or that there isn't one.

## What is actually modeled

| xyflow concept              | Plexus representation                |
| --------------------------- | ------------------------------------ |
| Flow                        | Root model                           |
| Node                        | `FlowNode` — position, type, label   |
| Edge                        | `FlowEdge` — points at two nodes     |
| Subflow / `parentId`        | Exclusive ownership (`children`)     |
| Node registry               | Synced `id → model` map              |
| Viewport, `selected`        | Local editor state                   |
| Cursor, remote selection    | Reactive awareness fields            |
| Undo / redo                 | Plexus document undo (`⌘Z`)          |

A group **owns** its children. An edge **points** at its ends. `selected`,
`dragging`, `measured`, and the viewport stay on the client.

`data` in this showcase is `label` — a field on `FlowNode`, not a JSON blob
and not a new Plexus field kind. Custom nodes in the demo write the model
directly: `node.label = event.target.value`.

## The backend is the wire

The showcase Worker (`showcase/xyflow/worker`) is a `plexus-do` host.
It names the Durable Object and plants the Flow seed — the first writer,
not an authority. Browsers speak y-websocket and only `connect`.

A `SharedWorker` remains the offline fallback when that host is down.
Two local bootstraps are two trees; do not treat the fallback as a second
first-writer in the same room.

Sync the `Y.Doc` first, then connect Plexus:

```tsx
import { Suspense, use } from "react";
import { ReactFlow, XyflowPlexus } from "@here.build/plexus-xyflow";

const ready = (async () => {
  await whenSynced(provider);
  return XyflowPlexus.connect(doc);
})();

function Canvas() {
  const plexus = use(ready);
  return <ReactFlow plexus={plexus} />;
}

<Suspense fallback="connecting…">
  <Canvas />
</Suspense>;
```

The Worker plants first-writer bytes with `Plexus.bootstrap` — the isolate
does not import the React entry. A warmed-up peer calls
`XyflowPlexus.connect(doc)`. Replacing the host means replacing the
provider setup, not the flow models or canvas binding.

For the underlying model API, see
[`@here.build/plexus`](https://github.com/here-build/plexus/tree/main/packages/plexus).

## Packages

| Package                           | What it contains                                      |
| --------------------------------- | ----------------------------------------------------- |
| `@here.build/plexus-xyflow-models` | `Flow`, `FlowNode`, `FlowEdge`                       |
| `@here.build/plexus-xyflow`        | Drop-in `<ReactFlow>` bound to a Plexus flow         |
| `plexus-xyflow-demo`               | One canvas, y-websocket client, and presence UI      |
| `plexus-xyflow-worker`             | plexus-do host — first writer, y-websocket           |

## Develop

```bash
# from the plexus repo root
pnpm install
pnpm --filter "./showcase/xyflow/**" test

# Worker (8788) + canvas (5174, proxies /docs → 8788)
pnpm --filter plexus-xyflow-demo dev:all
```

A missing `?room=` is written into the URL so the address is the invite.
**Copy link** puts that URL on the clipboard. The pill reads **live · Durable
Object** when the worker is up; **this tab only** means fallback bootstrap —
two local tabs are two documents, and the peer pane is withheld.
