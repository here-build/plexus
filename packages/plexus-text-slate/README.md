# `@here.build/plexus-text-slate`

Slate binding for `PlexusText` — collaborative single-paragraph rich text with awareness and liminality.

## Usage

```ts
import { Plexus } from "@here.build/plexus";
import { PlexusText } from "@here.build/plexus-text";
import { bindSlate, withLiminalGesture, createSlateBoundEditor } from "@here.build/plexus-text-slate";

const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
const root = plexus.root as PlexusText;
const editor = createSlateBoundEditor();

const unbind = bindSlate(editor, root, {
  doc,
  plexus,
  user: { name: "Ada", color: "#30bced" },
  onRemoteSelections: (remotes) => {
    // paint carets in React / your UI layer
  },
});

withLiminalGesture(plexus, () => {
  // ephemeral edits
});
```

Legacy: `bindSlate(editor, root, doc)` still works.

## Membrane law

See [`docs/working-proposals/plexustext-editor-membrane.md`](../../../../docs/working-proposals/plexustext-editor-membrane.md).

| Rule | How |
|---|---|
| Outbound | `textDiff` → `insertTextAt` / `deleteTextRange`; format ranges → `addMark` / `unformat` |
| Inbound | `textDiff` range replace + format range deltas — **never** `editor.children =` on the live path |
| Observe | MobX on projection + `doc.on("update")` safety net |
| Awareness | presence only (selection + user) — never content pull |
| Seed | once on empty editor; thereafter only diffs |

No CollabElementNode / second CRDT identity tree. The Slate tree is a **view**.

## Plate

Plate is UX/plugins over Slate. Use `@here.build/plexus-text-plate` for a thin `bindPlate` alias — same membrane, no second collab tree.
