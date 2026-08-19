# `@here.build/plexus-text-plate`

Thin **Plate-facing** API for `PlexusText`. Plate (Udecode) is UX and plugins over Slate — a Plate editor **is** a Slate `Editor`. The CRDT membrane lives in [`@here.build/plexus-text-slate`](../plexus-text-slate); this package does not invent a second collab tree and does not reimplement `textDiff`.

## Why this package exists

| Temptation | Why we refuse it |
|---|---|
| Dual tree (`CollabElementNode` + editor tree) | Second identity graph → mapping bugs, full rebuilds, Moment / y-prosemirror failure modes |
| Plate-specific CRDT adapter | Plate's collab surface is still Slate ops; a second binding would fork membrane law |
| Full `children =` pull on remote keystroke | Wipes selection, history, decorations — caret death |

## Usage

```ts
import { Plexus } from "@here.build/plexus";
import { PlexusText } from "@here.build/plexus-text";
import {
  bindPlate,
  createPlateBoundEditor,
  withLiminalGesture,
} from "@here.build/plexus-text-plate";

const plexus = Plexus.bootstrap(new PlexusText({}), id, doc);
const root = plexus.root as PlexusText;

// Pure Slate + history (no @udecode/plate required for v1)
const editor = createPlateBoundEditor();
// Or: const editor = createPlateEditor({ plugins: [...] }) from Plate — also fine

const unbind = bindPlate(editor, root, {
  doc,
  plexus,
  user: { name: "Ada", color: "#30bced" },
  onRemoteSelections: (remotes) => {
    // paint carets in React / Plate decorations
  },
});

withLiminalGesture(plexus, () => {
  // ephemeral edits
});
```

`bindPlate` is a thin alias of `bindSlate`. Same options, same unbind, same membrane.

## Membrane law

See [`docs/working-proposals/plexustext-editor-membrane.md`](../../../../docs/working-proposals/plexustext-editor-membrane.md).

1. **Outbound:** editor delta → `insertTextAt` / `deleteTextRange` / `addMark` / `unformat`
2. **Inbound:** model → **minimal** editor ops (`textDiff` range replace + format ranges). **Forbidden on live path:** clear-all / replace-entire-tree / re-seed
3. **Observe:** MobX on projection + `doc.on("update")` safety net
4. **Awareness:** presence only — never content pull
5. **No second collab identity tree** — editor tree is a **view**
6. **Seed once** on empty editor; thereafter only diffs

Prior-art failures this avoids: Moment, y-prosemirror full-tree rebuild, Lexical-collab dual-tree desync. See also `collaborative-editing-cohort-research.md` and `plexus-editor-binding-substrate.md`.

## API surface

| Export | Role |
|---|---|
| `bindPlate` | alias of `bindSlate` |
| `createPlateBoundEditor` | `createEditor` + history (pure Slate; works with any Plate editor) |
| `withLiminalGesture` | re-export from slate package |
| `getRemoteSelections` | re-export |
| `bindSlate` / types | re-export for hosts that want the Slate name |

## v1 scope

- Single-paragraph inline marks (bold / italic / code) — same as slate
- No dependency on `@udecode/plate*` (version fights); pure Slate is enough because Plate editors implement the Slate surface
- When you already use Plate, pass your Plate editor into `bindPlate` — plugins stay yours; collab stays the slate membrane
