---
title: Start
description: TypeScript classes synced through Yjs. MobX for reactivity. Loud errors instead of silent divergence.
---

<div class="hero">
  <h1>Plexus</h1>
  <p class="tag">Your TypeScript classes start to sync. Yjs underneath, MobX for reactivity. If something is wrong, it throws.</p>
  <img src="/hero.png" alt="I can’t believe it’s not local" width="480" />
  <p class="actions">
    <a class="btn primary" href="/excalidraw/">Excalidraw canvas</a>
    <a class="btn" href="/xyflow/">xyflow canvas</a>
    <a class="btn quiet" href="/laws/seed/">Seed law</a>
  </p>
</div>

The usual CRDT tutorial works. A TodoMVC-grade app also works. Then something does not sync, nothing throws, and days disappear. That is still the toy. Carnegie Mellon [ran a user study](https://doi.org/10.1184/R1/22277341.v1) on the exact ways people get hurt — fifteen JavaScript programmers, ninety minutes, a toy animal-shelter app, Yjs / Automerge / Collabs. There were no warnings. Subjects did not know anything was wrong until a second peer joined.

The standing complaint under a [widely-read Yjs tutorial](https://news.ycombinator.com/item?id=42743128): related objects, document boundaries, persistence, providers. The gap between the magic demos and anything real is wide.

Plexus fits the data model you already have. TypeScript classes become the CRDT. It does not replace Yjs or MobX.

```ts
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

@syncing("Task")
class Task extends PlexusModel<Project> {
  @syncing accessor title = "";
  @syncing accessor done = false;
}

@syncing("Project")
class Project extends PlexusModel {
  @syncing accessor name = "";
  @syncing.child.list accessor tasks: Task[];
}

const plexus = Plexus.bootstrap(new Project({ name: "ship" }));
```

<div class="cards">
  <article>
    <h2>Excalidraw</h2>
    <p>The editor stays the editor. The scene is a Plexus graph — frames own children, arrows only point.</p>
    <a href="/excalidraw/">Open canvas</a>
  </article>
  <article>
    <h2>xyflow</h2>
    <p>React Flow stays the view. Nested groups own their children; an edge that crosses owners is a handoff.</p>
    <a href="/xyflow/">Open canvas</a>
  </article>
  <article>
    <h2>Seed</h2>
    <p>A Y.Doc has no Plexus root until someone writes one. <code>bootstrap</code> plants it. <code>connect</code> waits.</p>
    <a href="/laws/seed/">bootstrap vs connect</a>
  </article>
  <article>
    <h2>API</h2>
    <p>The intended surface in one cheat sheet — models, <code>@syncing</code>, collections, undo.</p>
    <a href="/api/">Reference</a>
  </article>
</div>
