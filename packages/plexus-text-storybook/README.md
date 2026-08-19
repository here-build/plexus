# `@here.build/plexus-text-storybook`

Storybook demos for **PlexusText** editor bindings — **cross-iframe sync** over a local **MessageChannel → `YMessagePortProvider`** bridge (doc + awareness).

## Run

```bash
# from monorepo root
pnpm --filter @here.build/plexus-text-storybook install
pnpm --filter @here.build/plexus-text-storybook storybook
# → http://localhost:6012
```

Stories:

| Story | What it shows |
|---|---|
| **PlexusText / CodeMirror / CrossIframeSync** | Two CM iframes, live text + carets |
| **PlexusText / Lexical / CrossIframeSync** | Two Lexical iframes, text + bold/italic + remote caret HUD |

## Architecture

```
┌─ Story host ─────────────────────────────────────────────┐
│  1. Bootstrap seed PlexusText → encodeStateAsUpdate      │
│  2. MessageChannel                                       │
│  3. postMessage(init, [port]) → left iframe              │
│     postMessage(init, [port]) → right iframe             │
└──────────────────────────────────────────────────────────┘
         │ port1                    │ port2
         ▼                          ▼
┌─ iframe ──────────────┐  ┌─ iframe ──────────────┐
│ Y.applyUpdate(seed)   │  │ Y.applyUpdate(seed)   │
│ Plexus.connect        │  │ Plexus.connect        │
│ YMessagePortProvider  │◄─┤ YMessagePortProvider  │
│   (awareness shared)  │  │   (awareness shared)  │
│ CM / Lexical binding  │  │ CM / Lexical binding  │
└───────────────────────┘  └───────────────────────┘
```

Both peers **connect** from the same seed state (same root UUID). The bridge carries Yjs updates **and** multi-channel `PlexusAwareness` (selection + user). Liminal peer preview continues to work through Plexus’s built-in awareness `liminal` field.

## Files

- `src/components/DualIframeBridge.tsx` — host
- `public/iframe-cm.html` / `public/iframe-lexical.html` — peer shells
- `src/iframe/cm-peer.ts` / `lexical-peer.ts` — peer bootstrap
- `src/stories/*` — Storybook entries
