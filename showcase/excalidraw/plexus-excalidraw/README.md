# `@here.build/plexus-excalidraw`

Excalidraw as a view of a Plexus Scene. Same React children and plugins. The
document is the graph.

`@excalidraw/excalidraw` is a peer. Import its CSS from there.

The bind is a class. `ExcalidrawPlexus` extends `Plexus`: same instance
(`root`, `doc`, `awareness`, `undo`). Awareness is `ExcalidrawAwareness` —
cursor, selection, and name as `FieldAwareness` lanes on the Scene. Extend
the class to change identity, hue, or avatar.

Importing `ExcalidrawPlexus` imports `Scene`. `Scene.createElement` constructs
every document type, so those classes load and register. No ambient import.

## Warmup is pre-plexus

Sync the `Y.Doc` first. Then call the inherited statics. React 19
`use(promise)` is the canonical wait:

```tsx
import { Suspense, use } from "react";
import { Excalidraw, ExcalidrawPlexus, MainMenu } from "@here.build/plexus-excalidraw";

// 1. Attach your provider. This is warmup — not Plexus.
const doc = new Y.Doc();
const provider = new YourProvider("room", doc);

const ready = (async () => {
  await whenSynced(provider);
  // 2. Then Plexus. Authority bootstraps; a warmed-up peer connects.
  return ExcalidrawPlexus.connect(doc);
})();

function Canvas() {
  const plexus = use(ready);
  return (
    <Excalidraw plexus={plexus}>
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
      </MainMenu>
    </Excalidraw>
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
ExcalidrawPlexus.bootstrap(new Scene(), doc.guid, doc);
```

Do not import the React entry from a Worker. Use
`@here.build/plexus-excalidraw/plexus`.

## Extending

```ts
class AppAwareness extends ExcalidrawAwareness {
  getClientIdentity(clientId: number) {
    return { key: userIdFor(clientId) };
  }
}

class AppPlexus extends ExcalidrawPlexus {
  override awareness = new AppAwareness(this.doc);
}

plexus.awareness.setCursor(scene, { x, y });
plexus.awareness.cursor.get(); // { canvas, x, y } — canvas is the Scene
```

Worker and tabs must construct the **same** subclass. `Plexus.connect` refuses
a second class on the same doc.

## What the wrapper intercepts

- `plexus` — an `ExcalidrawPlexus` (or subclass).
- `initialData.elements` / `files` — from the graph. `appState` and
  `scrollToContent` still merge in.
- `excalidrawAPI` / `onChange` — composed; your callbacks still fire.
- Undo / redo — Plexus, including the editor's undo action.

Everything else (`children`, `UIOptions`, `onPaste`, `renderEmbeddable`,
library, AI plugins) is forwarded. `MainMenu`, `Footer`, `Sidebar`,
`DiagramToCodePlugin` must stay the originals so they keep Excalidraw's
context — they are re-exported, not rewritten.
