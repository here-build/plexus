---
title: Overview
description: Build a complete local model with TypeScript and MobX. Add shared identity and synchronization when it joins a Yjs document.
---

<div class="hero">
  <p class="eyebrow">TypeScript · Yjs · MobX</p>
  <h1>Local models. Shared when you need them.</h1>
  <p class="tag">Build your model with TypeScript classes, relationships, and MobX reactivity. When it joins a document, the same objects gain shared identity and Yjs synchronization. Keep working with them as usual.</p>
  <p class="actions">
    <a class="btn primary" href="/start/installation/">Get started <span aria-hidden="true">→</span></a>
    <a class="btn" href="/showcase/excalidraw/">Try a demo</a>
  </p>
</div>

## Start with a complete local model

Create objects, organize their relationships, and observe changes. Collections, parent-child relationships, and MobX reactivity all work locally, without creating a document.

```typescript
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

@syncing("Task")
class Task extends PlexusModel<Project> {
  @syncing accessor title = "";
  @syncing accessor done = false;
}

@syncing("Project")
class Project extends PlexusModel {
  @syncing.child.list accessor tasks!: Task[];
}

const project = new Project();
const task = new Task({ title: "Ship the editor" });

project.tasks.push(task); // task.parent === project, already locally
task.done = true;        // MobX observers see the change
```

## Add a shared context

When collaboration becomes part of the application, put that existing model into a document:

```typescript
const plexus = Plexus.bootstrap(project);

plexus.root === project;      // The same project instance
project.tasks[0] === task;    // The same task instance
task.parent === project;    // The same relationship
task.uuid;                   // Now identifiable across environments
```

The document adds replicated state and cross-environment identity. A provider can now exchange that state with other clients. Your existing references and observers keep working, including when changes arrive from a peer.

This is **progressive enhancement of the model**: local objects are useful on their own, and document membership adds the capabilities that need a shared context. [Follow the example from local to shared](/start/first-model/) to watch that transition happen.

## Useful locally, ready to share

<div class="cards benefits">
  <article>
    <h3>Move objects with their identity</h3>
    <p>Add parent-child relationships where your model needs ownership. Moving a block between groups updates both sides, and references still point to it. This works locally too.</p>
    <a href="/guide/ownership/">Ownership and references →</a>
  </article>
  <article>
    <h3>React to local and remote edits</h3>
    <p>Observe your local model with MobX. The same observers keep working when the model joins a document and receives changes from other clients.</p>
    <a href="/guide/time/">Reactivity and transactions →</a>
  </article>
  <article>
    <h3>Gain identity across environments</h3>
    <p>Locally, an object is its own identity. Joining a document adds a UUID so other environments can refer to that same entity.</p>
    <a href="/laws/lifecycle/#identity--uuids">Local and shared identity →</a>
  </article>
</div>

## Where Plexus fits

Your UI reads and writes **Plexus models**, and **MobX** tracks the fields it reads. When those models join a document, **Yjs** carries their replicated state. A **provider** exchanges updates between clients.

| Responsibility | Handled by |
| --- | --- |
| Models, ownership, references, document identity | Plexus |
| Replicated document updates | Yjs |
| Reactive reads and derived values | MobX, integrated by Plexus |
| Network connection and reconnection | Your Yjs provider |
| Persistence, authentication, authorization | Your application and server |

Use your existing Yjs infrastructure, or explore [plexus-do](https://github.com/here-build/plexus/tree/main/packages/plexus-do) for a Cloudflare Durable Object sync server. [Connecting clients](/start/connecting-clients/) explains who creates the document and when a client can join.

## Try it on a real application

<div class="cards">
  <article>
    <p class="eyebrow">Drawing editor</p>
    <h3>Excalidraw</h3>
    <p>Frames own shapes, arrows reference their endpoints, and the editor keeps its existing React surface. Edit a scene and watch a second client.</p>
    <a href="/showcase/excalidraw/">Explore the Excalidraw example →</a>
  </article>
  <article>
    <p class="eyebrow">Graph editor</p>
    <h3>React Flow</h3>
    <p>Move nodes between groups while edges keep their endpoints. Inspect how ownership and references map onto a graph.</p>
    <a href="/showcase/xyflow/">Explore the React Flow example →</a>
  </article>
</div>

## Why Plexus exists

The usual CRDT tutorial works. A TodoMVC-grade app also works. Then a real application introduces related objects, document boundaries, providers, and persistence. Something does not sync, nothing throws, and days disappear.

A Carnegie Mellon [user study](https://doi.org/10.1184/R1/22277341.v1) examined the difficulties JavaScript developers encounter with collaborative data libraries. The discussion under a [widely-read Yjs tutorial](https://news.ycombinator.com/item?id=42743128) points to the same gap between a working demo and an application with a substantial data model.

Plexus lets a model grow from local use into collaboration. Classes, collections, relationships, and reactive reads already work in a local application. Joining a document enriches those same objects with replicated state and shared identity. Operations that violate ownership or document invariants throw explicit errors, keeping the model understandable as its context grows.

<img class="signature" src="/hero.png" alt="I can't believe it's not local!" width="396" />
