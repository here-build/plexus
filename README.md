# Plexus

![I can't believe it's not local](packages/plexus/i-cant-believe-its-not-local.png)

The tutorial will work. Then something will not sync, nothing will throw,
and you will lose days.

You are not an idiot. This happens to everyone. It happens often enough
that Carnegie Mellon [ran a user study](https://doi.org/10.1184/R1/22277341.v1)
on the exact ways people get hurt — fifteen JavaScript programmers, ninety
minutes, a toy animal-shelter app, Yjs / Automerge / Collabs. There were no
warnings. Subjects did not know anything was wrong until a second peer
joined.

That is still the toy. The same late surprise is the standing complaint
under a [widely-read Yjs tutorial](https://news.ycombinator.com/item?id=42743128):
related objects, document boundaries, persistence, providers. "The gap
between the toy 'Look it's magic!' demos and anything real is just so wide."

**Plexus is how that punch lands at the assignment — or does not land.**
Your TypeScript classes are the CRDT. Yjs underneath. Doc, server, and
bootstrap are optional. Reactivity is MobX. It will crash early, or not
crash at all.

## Show it

TypeScript, stage-3 decorators (`experimentalDecorators` **off**):

```ts
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

@syncing
class Counter extends PlexusModel {
  @syncing accessor count = 0;
}

const plexus = Plexus.bootstrap(new Counter());
plexus.root.count++;
```

Connect any Yjs provider — [y-websocket](https://github.com/yjs/y-websocket),
[y-webrtc](https://github.com/yjs/y-webrtc), [Hocuspocus](https://hocuspocus.dev),
[PartyKit](https://partykit.io), [Liveblocks](https://liveblocks.io),
[y-sweet](https://github.com/jamsocket/y-sweet):

```ts
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
await provider.synced;
Plexus.connect(doc);
```

Contract, laws, and API: [`packages/plexus/README.md`](./packages/plexus/README.md).

## Crash early, or not at all

The questions are already answered. You do not keep a parallel `Y.Map`, a
parent index, an id generator, or a replica-init ritual. The class is the
schema; the rest is convention. At each fork the straightforward thing
is the supported thing. Trickery is possible. It is not the path the
API is built around.

- **Materialization is contagious.** Reachable from a doc means in that
  doc — child down, parent up. Different docs throw. No doc yet: the
  same objects, the same mutations, nothing on the wire.
- **Pointers, or ownership.** `@syncing` is a pointer. `@syncing.child`
  is a parent. Reparenting moves; cycles throw. `parent`, `parentField`,
  `parentFieldKey` are the reverse index — the question "where am I?"
  already has an answer.
- **One object, one id.** Models are singletons, including across
  materialization. Pointer identity never changes. Reaching for
  `.uuid` is one of two mistakes: a redundant step (the entity
  itself is the map key), or a name for a pointer that is not
  materialized yet. Both are bad. `.uuid` is an address for
  *elsewhere* — the wire, storage, another process — and it throws
  until the entity is a sync-candidate. There is no honest name to
  give you yet.
- **Constructors always work.** `new Page({ name })` is valid doc-free,
  as a subtree, and after it materializes. There is no second "create
  inside the doc" path.

Doc is optional. Server is optional. `bootstrap` is optional —
`Plexus.connect(existingDoc)`, or never connect. Reactivity is MobX, not
a second observer graph.

Violate a convention and it throws at the write. Ask a surface for
something it cannot honestly mean (`.uuid` with no doc) and it throws
at the read. Follow the simple path and it does not throw later.
**It will crash early, or not crash at all.**

The rest of the family covers the adjacent surprises — transports, routing,
a Durable Object sync server. It does not replace Yjs, and it does not
pretend persistence or providers were ever documented.

## Packages

- **`plexus`** — models, ownership, identity, undo, liminality, awareness.
  [`packages/plexus/README.md`](./packages/plexus/README.md)
- **`hono-plexus-do`** — Cloudflare Durable Object sync: leader/follower
  lanes, persistence, presence, spill, archive. FSL-1.1-MIT; the rest of
  the family is MIT.
- **`plexus-vfs`** — dirs, files, and entity paths as plexus models; an
  `fs` for isomorphic-git.
- **`y-messageport`** + **`y-control-channel`** — a real Provider over
  `MessagePort` (workers, shared workers, frames), and the port-routing
  control plane it composes with. The custom-provider tutorial is still a
  blank page; this is not.

## Install

```bash
git clone git@github.com:here-build/plexus.git && cd plexus
pnpm install
pnpm build
pnpm test
```

Workspace under `packages/*`. Depend via `workspace:` / path, or (once
published) `@here.build/plexus` and siblings.

Peers: `yjs`, `y-protocols`, `lib0`, `mobx` (see each package). Floor packages
from [@here.build/commons](https://github.com/here-build/commons)
(`collections`, `arrival-env`, `chunked-websocket`, `error-invariant`,
`tsconfig`, `eslint-configs`) resolve from npm at `0.9.0`.

## License

[MIT](./LICENSE.md), except [`hono-plexus-do`](./packages/hono-plexus-do/LICENSE.md)
which is [FSL-1.1-MIT](./packages/hono-plexus-do/LICENSE.md).
