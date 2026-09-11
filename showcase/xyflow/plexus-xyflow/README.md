# `@here.build/plexus-xyflow`

xyflow as a view of a Plexus Flow. Same React children (`MiniMap`, `Controls`,
`Background`). The document is the graph.

`@xyflow/react` is a peer. Import its CSS from there.

The bind is a class. `XyflowPlexus` extends `Plexus`: same instance (`root`,
`doc`, `awareness`, `undo`). Awareness is `XyflowAwareness` — cursor,
selection, and name as `FieldAwareness` lanes on the Flow. Extend the class
to change identity, hue, or avatar.

Importing `XyflowPlexus` imports `Flow`, so `@syncing` registers `FlowNode`
and `FlowEdge`. No ambient import.

## Warmup is pre-plexus

Sync the `Y.Doc` first. Then call the inherited statics. React 19
`use(promise)` is the canonical wait:

```tsx
import { Suspense, use } from "react";
import { ReactFlow, XyflowPlexus } from "@here.build/plexus-xyflow";

const doc = new Y.Doc();
const provider = new YourProvider("room", doc);

const ready = (async () => {
  await whenSynced(provider);
  return XyflowPlexus.connect(doc);
})();

function Canvas() {
  const plexus = use(ready);
  return (
    <ReactFlow plexus={plexus}>
      <Background />
      <Controls />
    </ReactFlow>
  );
}

export function App() {
  return (
    <Suspense fallback="connecting…">
      <Canvas />
    </Suspense>
  );
}
```

`whenSynced` is whatever your provider already has. Authority on an empty doc:

```ts
XyflowPlexus.bootstrap(new Flow(), doc.guid, doc);
```

Do not import the React entry from a Worker. Use
`@here.build/plexus-xyflow/plexus`.

`selected` is editor state. Graph snapshots never carry it. Remote updates
keep the previous flags; a `select` change rewrites them.

## Extending

```ts
class AppAwareness extends XyflowAwareness {
  getClientIdentity(clientId: number) {
    return { key: userIdFor(clientId) };
  }
}

class AppPlexus extends XyflowPlexus {
  override awareness = new AppAwareness(this.doc);
}

plexus.awareness.setCursor(flow, { x, y });
plexus.awareness.cursor.get(); // { canvas, x, y } — canvas is the Flow
```

Worker and tabs must construct the **same** subclass. `Plexus.connect` refuses
a second class on the same doc.
