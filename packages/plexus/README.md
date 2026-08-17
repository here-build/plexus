# @here.build/plexus

![i-cant-believe-its-not-local.png](i-cant-believe-its-not-local.png)

Reactive state management with automatic replication in familiar style.
Just make TypeScript classes sync across clients via most popular JS CRDT protocol and one of most mature T-FRP JS engines.

```bash
npm install @here.build/plexus
```

## Who this is for

**Plexus is the layer that makes your TypeScript classes the CRDT** — MobX for reactivity, any Yjs provider you already trust.

Yjs is great CRDT engine - but it forces to build the data model around its own primitives. Plexus offers the opposite - keep your data model, or build one from scratch in TypeScript, and make it CRDT-backed without changing anything at all.

If you do not want to design your whole application around `Y.Array` and `Y.Map`, this is for you. 

## Quick Start

> You will need to use **TypeScript** with **stage-3 decorators** specifically.
> 
> To enable stage-3, you need to have `experimentalDecorators` in `tsconfig.json` **disabled**.

```typescript
import * as Y from "yjs";
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

// you will need only three entities - @syncing.* to annotate... 
@syncing("Counter")
//  ...PlexusModel to extend from...
class Counter extends PlexusModel {
  @syncing accessor count = 0;
}
//  ...and Plexus to connect the document to the model.
const plexus = Plexus.bootstrap(new Counter());
//  And it's just synced to all connected clients
plexus.root.count++;
```

Connect any Yjs provider — [y-websocket](https://github.com/yjs/y-websocket), [y-webrtc](https://github.com/yjs/y-webrtc), [Hocuspocus](https://hocuspocus.dev), [PartyKit](https://partykit.io), [Liveblocks](https://liveblocks.io), [y-sweet](https://github.com/jamsocket/y-sweet) —
for real-time sync. Same `doc` as `bootstrap`:

```typescript
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
Plexus.bootstrap(new Counter(), doc.guid, doc);
```

Joining a room that already has a root is `connect`, not `bootstrap`. Those are separate flows: `bootstrap` produces the initial root (not an authority); `connect` never does — [bootstrap vs connect](./docs/bootstrap.md).

## Rich Data Structures and Contagious Materialization

Plexus provides parent-child relations represented, support of lists (arrays), records, maps (with structural keys) and seamless mobx integration.

What is does not provide is manual sync management - because it produce structural sync guarantees. You push, add, or set models - rest is done automatically. The moment model gets related to the materialized entity, it gets represented inside CRDT document, along with all its own related models - contagiously. 

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
const root = plexus.root;

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

## Docs

- [bootstrap](./docs/bootstrap.md) — blank doc writes the seed; prefilled doc uses `connect`
- [fields](./docs/fields.md) — `@syncing` field kinds, ownership vs reference
- [shape](./docs/shape.md) — constructors and inheritance
- [lifecycle](./docs/lifecycle.md) — materialization is contagious; identity, detach, clone
- [time](./docs/time.md) — MobX, `@syncing.action`, undo
- [find](./docs/find.md) — `loadEntity`, `getAllOfType`, `parentsOf`
- [goodies](./docs/goodies.md) — virtual maps, `declare`, lazy containers
- [awareness](./docs/awareness.md) — presence
- [walk](./docs/walk.md) — schema-aware tree walk
- [errors](./docs/errors.md) — error types
- [api](./docs/api.md) — API wrap-up
- [internals](./docs/internals.md) — `/internals`

## License

[MIT](./LICENSE.md).
