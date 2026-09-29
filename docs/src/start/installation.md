---
title: Installation
description: Set up a TypeScript project and build a local model that can later join a shared document.
---

The tutorial uses Node.js 22 or newer and TypeScript. Start with local objects, ownership, and reactive reads. Then put that same model into a document and exchange updates with a second replica. Both replicas run in one process, so the whole tutorial works without a server.

## Create a project

```bash
npm install @here.build/plexus yjs mobx@6 y-protocols lib0
npm install --save-dev typescript @types/node
```

Plexus uses Yjs for document state and MobX for reactive reads. `y-protocols` and `lib0` are peer dependencies used by the collaboration infrastructure.

## Dependency versions

Plexus was checked with these versions through builds, type checks, tests, and a clean installation of the packed libraries:

| Peer | Peer range | Version checked |
| --- | --- | --- |
| Yjs | `^13.6.33` | `13.6.33` |
| MobX | `^6.16.1` | `6.16.1` |
| y-protocols | `^1.0.7` | `1.0.7` |
| lib0 | `^0.2.119` | `0.2.119` |

These are the tested lower bounds. A caret allows compatible updates: `^13.6.33` stays below `14.0.0`, while `^0.2.119` stays below `0.3.0`. It does not mean every future version has already been tested. Commit your application's lockfile to keep installations reproducible. The workspace pins development copies to the versions checked above.

MobX stays on version 6, as the whole ecosystem is currently working with v6. v7 is great release, but for compatibility reasons, v6 is used.

Use one Yjs module instance for the application and its providers: duplicate copies can break constructor checks. `plexus-do` also declares Yjs as a peer; its `lib0` and `y-protocols` dependencies are installed automatically. `y-messageport` requires Yjs and y-protocols as peers, with MobX optional for its `/mobx` entry point. `y-control-channel` only needs MobX when using `/mobx` and does not require Yjs.

`plexus-vfs` shares the application's Plexus instance through a peer dependency. Its other peers are lib0, MobX, Yjs, and `isomorphic-git@^1.42.3`; isomorphic-git is required because its types appear in the public declarations. `tslib` is a runtime dependency installed automatically.

## Configure TypeScript

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ESNext", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true,
    "experimentalDecorators": false // we need this specific line
  },
  "include": ["src/**/*.ts"]
}
```

Plexus uses [standard TypeScript decorators](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#decorators) on `accessor` declarations. An existing project using legacy `experimentalDecorators: true` needs its decorator configuration changed before using these examples. Compile with `tsc` to emit JavaScript that Node can run.

## Continue with a model

In [From local to shared](/start/first-model/), create `src/models.ts` and `src/index.ts`. Then run:

```bash
npx tsc
node dist/index.js
```

The example first observes local edits, then keeps that observer as the model joins a document and receives a remote edit. You can run the local portion on its own. The following chapter adds a Yjs provider for communication between clients.

## Working in this repository

To explore the library and the existing demos from source:

Use Node.js 22 or newer and the `pnpm@10.34.6` version recorded in the root `packageManager` field.

```bash
git clone https://github.com/here-build/plexus.git
cd plexus
pnpm install --frozen-lockfile
pnpm build
pnpm --filter plexus-docs dev
```

The workspace normally waits seven days before installing newly published dependencies. `pnpm-workspace.yaml` exempts `@here.build/*` and the explicitly selected `yjs@13.6.33`, `lib0@0.2.119`, and `isomorphic-git@1.42.3` releases. These version-specific exceptions do not exempt future releases of those libraries.

The [Excalidraw example](/showcase/excalidraw/) and [React Flow example](/showcase/xyflow/) include commands for running their full local stacks.
