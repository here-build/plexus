# `@here.build/plexus-text-lexical`

Lexical binding for `PlexusText` — collaborative inline rich text with awareness and liminality.

## Usage

```ts
import { Plexus } from "@here.build/plexus";
import { PlexusText } from "@here.build/plexus-text";
import { bindLexical, withLiminalGesture, getRemoteSelections } from "@here.build/plexus-text-lexical";

const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
const root = plexus.root as PlexusText;

const unbind = bindLexical(editor, root, {
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

Legacy: `bindLexical(editor, root, doc)` still works.

## What it does

| Feature | How |
|---|---|
| Two-way text | `textDiff` → `insertTextAt` / `deleteTextRange` |
| Two-way format | bold / italic / code via `addMark` / `unformat` |
| Awareness | publishes `selection` + `user`; `onRemoteSelections` / `getRemoteSelections` for peer carets |
| Liminality | re-project on awareness change after Plexus applies peer previews |
| Echo guard | `COLLAB_TAG` + reentrancy flag |

## Notes

- Single-paragraph first cut. Inbound is **minimal**: `textDiff` + format range deltas — never clear-and-rebuild the paragraph (caret-preserving).
- Observation: MobX on the entity projection + `doc.on("update")` safety net. Awareness is presence-only (not a content re-render trigger).
- Remote carets are **data**, not Lexical nodes — render them in your host UI from `onRemoteSelections`.
