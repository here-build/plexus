---
title: From local to shared
description: Build a reactive local model, then give the same objects a shared document and a second replica.
---

Start with the project from [Installation](/start/installation/). First, use the model locally: create tasks, establish ownership, and react to edits. Then add a document and a second replica. The original objects and observer stay in place throughout.

## Define the model

Create `src/models.ts`:

```typescript
import { PlexusModel, syncing } from "@here.build/plexus";

@syncing("Task")
export class Task extends PlexusModel<Project> {
  @syncing accessor title = "";
  @syncing accessor done = false;
}

@syncing("Project")
export class Project extends PlexusModel {
  @syncing accessor name = "";
  @syncing.child.list accessor tasks!: Task[];
}
```

`@syncing("Task")` registers the model type. Decorated accessors support reactive reads and writes locally and become synchronized fields when their model joins a document. `.child.list` adds ownership: the project knows its tasks, and each task knows its parent. An omitted collection starts empty.

## Use it locally

Create `src/index.ts`. Add the following blocks to this file in order:

```typescript
import { reaction } from "mobx";
import { Project, Task } from "./models.js";

const project = new Project({ name: "Ship the editor" });
const stop = reaction(
  () => project.tasks.filter((task) => !task.done).length,
  (open) => console.log(`Open tasks: ${open}`),
  { fireImmediately: true },
);

const task = new Task({ title: "Write the docs" });
project.tasks.push(task);
console.log(`Local owner: ${task.parent === project}`);
task.done = true;
```

You can already run this portion with `npx tsc` and `node dist/index.js`:

```text
Open tasks: 0
Open tasks: 1
Local owner: true
Open tasks: 0
```

There is no document or provider. You have a working local model with collections, relationships, and reactivity. Keep using it this way for as long as the application needs. When you are finished observing it, call `stop()`; for the following steps, leave the observer active.

## Give the model a document

Continue in `src/index.ts`:

```typescript
import { Plexus } from "@here.build/plexus";

const alice = Plexus.bootstrap(project);
console.log(`Same local instance: ${alice.root === project}`);
```

`bootstrap` creates a document around the existing project and its task. The project, task, parent relationship, and MobX observer remain in place. Their state can now be replicated, and the models have UUIDs that identify them across environments.

Locally, you can identify `task` by its JavaScript reference and use it directly as a map key. `.uuid` serves a different scope: identifying the entity in another environment. It becomes available when the entity joins a document, even before any updates have been sent over a network.

## Connect a second replica

Continue in the same file:

```typescript
import * as Y from "yjs";

const bobDoc = new Y.Doc();
Y.applyUpdate(bobDoc, Y.encodeStateAsUpdate(alice.doc));
const bob = Plexus.connect(bobDoc);
const bobProject = bob.root as Project;

console.log(`Bob sees: ${bobProject.tasks[0].title}`);
```

Both replicas run in this process with separate documents and model instances. We explicitly copy Alice's document state to Bob, then call `connect` to load the root. In separate environments, each client must load the same model definitions before connecting.

The cast describes the root type this application expects. The model decorators register the runtime types; a TypeScript cast alone cannot do that. Call `connect` after the initial root has arrived. [Connecting clients](/start/connecting-clients/) explains the creation and joining flows.

## Receive an edit in the existing observer

Bob reopens the task. Finish `src/index.ts`:

```typescript
bobProject.tasks[0].done = false;
Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc));

console.log(`Same task instance: ${project.tasks[0] === task}`);
console.log(`Same shared identity: ${
  task.uuid === bobProject.tasks[0].uuid
}`);

stop();
alice.destroy();
bob.destroy();
```

The observer you created for the local model reports the change from Bob. Alice still holds the original task instance. Bob has his own instance with the same replicated UUID.

## Run the complete example

```bash
npx tsc
node dist/index.js
```

Expected output:

```text
Open tasks: 0
Open tasks: 1
Local owner: true
Open tasks: 0
Same local instance: true
Bob sees: Write the docs
Open tasks: 1
Same task instance: true
Same shared identity: true
```

The model has gained a shared context while preserving its local behavior. This example sends complete document updates at explicit points. A provider handles ongoing exchange and reconnection between environments. Continue to [Connecting clients](/start/connecting-clients/) when you need that communication.
