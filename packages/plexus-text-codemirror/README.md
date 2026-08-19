# `@here.build/plexus-text-codemirror`

CodeMirror 6 binding for `PlexusText` — collaborative plain text with awareness carets and liminality.

## Usage

```ts
import { EditorView } from "@codemirror/view";
import { Plexus } from "@here.build/plexus";
import { PlexusText } from "@here.build/plexus-text";
import { plexusTextSync, withLiminalGesture } from "@here.build/plexus-text-codemirror";

const doc = /* Y.Doc */;
const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
const root = plexus.root as PlexusText;

const view = new EditorView({
  extensions: [
    plexusTextSync(root, {
      doc,
      plexus, // enables liminal re-render + uses plexus.awareness
      user: { name: "Ada", color: "#30bced" },
    }),
  ],
  parent: el,
});

// Ephemeral gesture (one undo step on commit)
withLiminalGesture(plexus, () => {
  // type / programmatically edit while liminal
});
```

Legacy: `plexusTextSync(root, doc)` still works (text sync only).

## What it does

| Feature | How |
|---|---|
| Two-way text | `insertTextAt` / `deleteTextRange` on the entity sequence |
| Remote carets | `PlexusAwareness` fields `selection` + `user`; CM decorations |
| Liminality | Writes ride Plexus shadow while `isLiminal`; peer previews via awareness (Plexus auto-applies); binding re-projects on awareness change |
| Echo guard | `fromPlexus` annotation + reentrancy flag |

## Presence fields

- `user`: `{ name?, color? }`
- `selection`: `{ anchor, head }` — UTF-16 offsets in `toText`
- `liminal`: **reserved** by Plexus core
