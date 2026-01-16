# @here.build/plexus

Reactive state management with automatic replication. TypeScript classes that sync across clients via Yjs CRDTs.

```bash
npm install @here.build/plexus
```

## Quick Start

> You will need to use TypeScript with stage-3 decorators specifically. Make sure that `experimentalDecorators` in
`tsconfig.json` is disabled.

```typescript
import * as Y from "yjs";
// this is all API you will need
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

@syncing
class Counter extends PlexusModel {
  @syncing accessor count: number = 0;
}

const plexus = Plexus.bootstrap(new Counter(), new Y.Doc());
plexus.root.count++; // Synced to all connected clients
```

Connect any Yjs
provider - [y-websocket](https://github.com/yjs/y-websocket), [y-webrtc](https://github.com/yjs/y-webrtc), [Hocuspocus](https://hocuspocus.dev), [PartyKit](https://partykit.io), [Liveblocks](https://liveblocks.io), [y-sweet](https://jamsocket.com/y-sweet) -
for real-time sync:

```typescript
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
await provider.synced; // implementation vary between providers - see docs
Plexus.connect(doc);
```

## Defining Models

```typescript
@syncing
class Project extends PlexusModel {
  // Primitives and references
  @syncing accessor title: string = "";
  @syncing accessor owner: User | null = null;
  @syncing accessor createdAt: Date = new Date();

  // Collections
  @syncing.list accessor members: User[] = [];
  @syncing.set accessor tags: Set<string> = new Set();
  @syncing.record accessor metadata: Record<string, string> = {};
  @syncing.map accessor scores: Map<User, number> = new Map();

  // Computed properties work as expected. It's just JS.
  get memberCount() {
    return this.members.length;
  }
}

@syncing
class SuperProject extends Project {
  // model name is optional but may be useful to solve mangling issues
  static readonly modelName = "Project*";

  // you can redefine types, including sync types, in inherited classes.
  // there will be TS issues, since 
  // @ts-expect-error
  @syncing.child accessor title: string | RichName = "";
}
```

**Supported types:** `string`, `number` (including `Infinity`, `-Infinity`, `NaN`), `boolean`, `null`, `bigint`, `Date`,
`Uint8Array`, `Blob` (experimental), and `PlexusModel` references.

Note that `undefined` is not supported and will be turned into `null`.

## Using Models

```typescript jsx
// all @syncing fields can be passed inside the constructor argument
const project = new Project({ title: 'hello', members: [user] });
// even when omitted, structs will be created empty
project.tags.add("test");
// There is no difference between synced and non-synced models.
// You may work with local model instances, then add them in plexus root and they will be
// synced automatically. Think of it like sync spreads on touch.
plexus.root.projects.push(project);
```

In addition, every model instance has stable `.uuid` field since beginning (specifically, `nanoid` format is used).
You can use it for external references.

## Map Keys

Maps use structural equality for keys—Sets, Arrays, Dates, tuples, and PlexusModel references all work:

```typescript
@syncing.map accessor byDimensions: Map<Set<string>, number> = new Map();

// Order doesn't matter for Set keys
map.set(new Set(["a", "b"]), 42);
map.get(new Set(["b", "a"])); // 42

// Arrays and tuples are order-sensitive
@syncing.map accessor events: Map<[Date, string], Event> = new Map();
@syncing.map accessor userActions: Map<[User, Date, string], Action> = new Map();

// Models as keys, including mixed compound keys
@syncing.map accessor scores: Map<User, number> = new Map();
@syncing.map accessor assignments: Map<Set<User | Date>, Task> = new Map();
```

This behavior differs from "normal" JS behavior intentionally, since "pointer reference" maps are pointless concepts in
collaborative environments - you cannot pass `new Set()` to other machine; all you can do is structural comparisons.
However, this concept is pretty powerful to define many-to-one relations (also known as hyperedges) like this:
`Map<Set<User>, Group>`.

## Child Fields and Ownership

Use `.child` for parent-child relationships with automatic reparenting:

```typescript
@syncing
class Project extends PlexusModel {
  @syncing.child.list accessor pages: Page[];
}

@syncing
class KitchenSink extends PlexusModel {
  @syncing.child.set accessor everything: Set<PlexusModel>; 
}

@syncing
class Page extends PlexusModel<Project> {
    @syncing name: string;
}

// Moving between parents
const page = new Page({name: 'homepage'});
project1.pages.push(page); // page.parent is project1 now
project2.pages.push(page); // page.parent is project2 - and project1.pages is empty
kitchenSink.everything.add(page); // cross-structure moves works too - page.parent is kitchenSink now
```

`@syncing.child`, `@syncing.child.set`, `@syncing.child.list`, `@syncing.child.record` are supported.

> Maps are special due to models being allowed to use as keys, which cause uncertainty on multiple levels. Ownership
> tracking is intentionally disabled for them for now due to multiple unclear behaviors.

## Reactivity

Use MobX 6.x integration for automatic fine-grained tracking:

```typescript
// use automatic register - recommended
import "@here.build/plexus/mobx/register";
// or manual initializer
import { enableMobXIntegration } from "@here.build/plexus/mobx";
import { autorun } from "mobx";

autorun(() => {
  console.log(`${project.title}: ${project.members.length} members`);
});

project.title = "Updated"; // Triggers reaction
```

Without MobX, use `createTrackedFunction`:

```typescript
import { createTrackedFunction } from "@here.build/plexus";

const track = createTrackedFunction(
  () => console.log("Changed!"),
  () => [project.title, project.members.length]
);
// "Changed!" will be emitted once after every track() call. 
track();
```

> This is extremely minimal tracking, is intended to be used in environments without mobx and is fallback system

## Transactions

Batch changes into a single sync event:

```typescript
// plexus.transact abstracts both reactivity and yjs transactions.
// mobx autorun() will trigger only once after transaction is done.
// Note that mobx transaction actions are not integrated - if mixing values of reactive systems,
// you will need to use both plexus.transact() and action().
plexus.transact(() => {
  project.title = "New Title";
  project.members.push(user1, user2);
  project.metadata.status = "active";
});
```

## API

```typescript
// Bootstrap with root model - use when doc is empty.
// sometimes you may need custom document, but by default doc is created.
const plexus = Plexus.bootstrap(root: PlexusModel, doc?: Y.Doc);

// Or connect to existing Yjs doc. Wait for document sync before connecting - connect is sync.
const plexus = Plexus.connect(existingDoc);

// Access root and doc
plexus.root;
plexus.doc;

// Load entity by UUID (singleton, always same instance guarantee)
const project = plexus.loadEntity<Project>(uuid);
```
