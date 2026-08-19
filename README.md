# Plexus

![I can't believe it's not local](packages/plexus/i-cant-believe-its-not-local.png)

Here's how everyone starts their journey with CRDT.

You encounter the demand for some collaboration features, and encounter
Yjs, or Automerge, or any other library.
The tutorial will work; TodoMVC grade app also works.
Then something will not sync, nothing will throw, and you will lose days debugging.

You are not stupid - this happens to literally everyone. It happens often enough
that Carnegie Mellon had a reason to [run a user study](https://doi.org/10.1184/R1/22277341.v1)
on the exact ways people get hurt - fifteen JavaScript programmers, ninety
minutes, a toy animal-shelter app, Yjs / Automerge / Collabs. There were no
warnings. Subjects did not know anything was wrong until a second peer
joined.

That is still the toy. The same late surprise is the standing complaint
under a [widely-read Yjs tutorial](https://news.ycombinator.com/item?id=42743128):
related objects, document boundaries, persistence, providers. _"The gap
between the toy 'Look it's magic!' demos and anything real is just so wide."_

**Plexus is built to fit the data model you already have.**
Your TypeScript classes start to sync. Yjs underneath. Reactivity is MobX. And if something goes wrong - it throws, loudly and explicitly. Nothing breaks silently, slipping into the production.

Here's how it look like:

```typescript
import { autorun, computed } from "mobx";
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

@syncing("Task")
class Task extends PlexusModel<Project> {
  @syncing accessor title = "";
  @syncing accessor done = false;
}

@syncing("Project")
class Project extends PlexusModel {
  @syncing accessor name = "";
  @syncing.list accessor labels: string[];
  @syncing.set accessor tags: Set<string>;
  @syncing.record accessor meta: Record<string, string>;
  @syncing.map accessor scores: Map<[team: string, player: number], number>;
  @syncing.child.list accessor tasks: Task[];

  // local derivation, global inputs — peers writing .done invalidate this too
  @computed get openCount() {
    return this.tasks.filter((t) => !t.done).length;
  }
}

const plexus = Plexus.bootstrap(new Project({ name: "ship" }));
const root = plexus.root; // Project is root now

autorun(() => {
  console.log(`${root.name}: ${root.openCount} open`);
});

const task = new Task({ title: "write the demo" }); // no doc
root.tasks.push(task); // now it is — peers have the Task
root.labels.push("v1");
root.tags.add("urgent");
root.meta.area = "core";
root.scores.set(task.title, 10);
task.done = true; // computed updates; so do peers
```

Class API, seed vs join, collections, contagion:
[`packages/plexus`](./packages/plexus/README.md).

The rest of the family covers the adjacent surprises - transports, routing,
a Durable Object sync server. It does not replace Yjs or MobX; Plexus is designed to be non-owning, integrating into production-tested infrastructure rather then inventing one. 

## Packages

- **[`plexus`](./packages/plexus/README.md)** - models, ownership, identity, undo, awareness
- **[`plexus-do`](./packages/plexus-do/README.md)** - Cloudflare Durable Object sync: leader, archive, presence. FSL-1.1-MIT; the rest of the family is MIT
- **[`plexus-vfs`](./packages/plexus-vfs/README.md)** - dirs, files, and entity paths as plexus models; an `fs` for isomorphic-git
- **[`y-messageport`](./packages/y-messageport/README.md)** + **[`y-control-channel`](./packages/y-control-channel/README.md)** - a Provider over `MessagePort`, and the port-routing control plane it composes with

## Showcase

- **[`showcase/excalidraw`](./showcase/excalidraw)** - Excalidraw's scene as a Plexus graph. Not a rewrite of the editor.

## Install

```bash
git clone git@github.com:here-build/plexus.git && cd plexus
pnpm install
pnpm build
pnpm test
```

Workspace under `packages/*` and `showcase/excalidraw/*`. Depend via `workspace:` / path, or (once
published) `@here.build/plexus` and siblings.

Peers: `yjs`, `y-protocols`, `lib0`, `mobx` (see each package). Floor packages
from [@here.build/commons](https://github.com/here-build/commons)
(`collections`, `arrival-env`, `chunked-websocket`, `error-invariant`,
`tsconfig`, `eslint-configs`) resolve from npm at `0.9.0`.

## License

[MIT](./LICENSE.md), except [`plexus-do`](./packages/plexus-do/LICENSE.md)
which is [FSL-1.1-MIT](./packages/plexus-do/LICENSE.md).
