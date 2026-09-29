---
title: Connecting clients
description: Create the shared document once, then let a Yjs provider exchange updates between clients.
---

In [From local to shared](/start/first-model/), a local model gained document identity and exchanged updates with a second replica. A provider adds communication between environments by connecting each client's `Y.Doc` to the same room. The application continues to read and write its models as before.

## Decide who creates the document

A shared document needs one initial root. Choose a creation flow in your application: a server creates and stores it, or a designated client creates a new room before others join.

| Situation | Operation |
| --- | --- |
| Creating a genuinely new document | `Plexus.bootstrap(root, documentId, doc)` |
| Opening an existing document | Synchronize or restore its state, then `Plexus.connect(doc)` |
| Reconnecting after losing the network | Let the provider resynchronize the existing document |

**An empty local document does not prove the room is new.** Its state may still be loading. If two offline clients independently bootstrap the same room, they create competing roots. The room-creation flow must establish who writes first. See [the seed rule](/laws/seed/) for the reasoning.

## Connect through a provider

The following browser snippets use [y-websocket](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket). They assume a running y-websocket-compatible server and the shared `Project` and `Task` definitions from the tutorial.

```bash
npm install y-websocket
```

In both clients, import the model module so its decorators register the types:

```typescript
import { Plexus } from "@here.build/plexus";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { Project } from "./models.js";
```

### The designated creator

Run this flow only when your application has established that the room is new. Replace the example server address and room name with your own:

```typescript
const doc = new Y.Doc();
const project = new Project({ name: "Ship the editor" });
const plexus = Plexus.bootstrap(project, doc.guid, doc);
const provider = new WebsocketProvider(
  "wss://your-sync-server.example",
  "project-123",
  doc,
);
```

Make the seeded document available on the server before inviting joiners. Provider synchronization confirms exchange with the server; durable storage depends on the server's implementation.

### A joining client

The joiner uses the same server and room and waits for initial synchronization:

```typescript
const doc = new Y.Doc();
const provider = new WebsocketProvider(
  "wss://your-sync-server.example",
  "project-123",
  doc,
);

await new Promise<void>((resolve) => {
  if (provider.synced) {
    resolve();
    return;
  }
  const onSync = (synced: boolean) => {
    if (!synced) return;
    provider.off("sync", onSync);
    resolve();
  };
  provider.on("sync", onSync);
});

const plexus = Plexus.connect(doc);
const project = plexus.root as Project;
```

`provider.synced` is a boolean, not a promise. The `sync` event signals when the initial exchange completes. A synchronized room can still be empty if nobody created it; `connect` then throws. Surface loading and connection failures in your UI and handle missing documents through your application's creation flow.

Once connected, write to `project` as usual. The provider transfers updates and Plexus applies them to the local models. Destroy the provider before destroying the Plexus instance when closing the document:

```typescript
provider.destroy();
plexus.destroy();
```

## Choose the infrastructure

Plexus manages the model. Your application chooses the provider, authentication, room permissions, and persistence. For a server in this repository, see [plexus-do](https://github.com/here-build/plexus/tree/main/packages/plexus-do).

To try a complete integration, open the [Excalidraw example](/showcase/excalidraw/) or [React Flow example](/showcase/xyflow/). Their pages explain which transport is available on GitHub Pages and how to run the full stack locally.

## Continue building your model

Read [Models and fields](/guide/fields/) for supported values and collections, then [Ownership and references](/guide/ownership/) to model relationships between objects.
