## Bootstrap vs Connect

A `Y.Doc` has no Plexus root until someone writes one. Yjs will not invent a tree.
That first write is the **seed**: the root entity and the root pointer in the doc.

- **`Plexus.bootstrap(root, documentId?, doc?)`** — plant the seed on a **blank** doc. First writer.
- **`Plexus.connect(doc)`** — bind to a doc that **already has** the seed. Everyone else, after sync.

The two methods are separate flows, not ranks. `bootstrap` is the peer that produces the initial root — not an authority, not a leader, not the owner of the doc after the write. `connect` never writes a seed.

```typescript
// First writer — blank doc
const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
Plexus.bootstrap(new Project({ name: "ship" }), doc.guid, doc);

// Joiner — wait until the seed is on the wire
const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
await provider.synced;
const plexus = Plexus.connect(doc);
```

`connect` on a blank doc throws `no root found, await sync first`.
`bootstrap` on a doc that already has a root plants a second seed. Don't.

> Why two verbs?
>
> A CRDT merge cannot invent a distinguished root. If every peer creates "the document"
> you get two trees that both look like the app. Someone has to write the seed once;
> everyone else has to wait for it. `bootstrap` is that write. `connect` is that wait.

This is the usual Yjs wound. Two first-writers look like "the doc is not syncing":

> two (or more) people enter a document in an offline state. This document say has a
> initial value [...] Now two people go to the same document in offline mode, so both
> their documents are initialzed with the initial document value. When one goes online,
> all good. When the other goes online, this initial document is duplicated.
>
> — [aliak00, *Initial offline value of a shared document*](https://discuss.yjs.dev/t/initial-offline-value-of-a-shared-document/465)

Same shape with two empty notebook cells: both users "just open the blank document";
after sync the content is `<cell /><cell />`
([YousefED, same thread](https://discuss.yjs.dev/t/initial-offline-value-of-a-shared-document/465)).

> Only one peer should populate the document with content. Populating content is an
> insertion. Therefore, duplicate insertions of “default content” will always lead to
> duplication of content. [...] only initialize a document once. This can happen on
> the first client that creates a document.
>
> — [Kevin Jahns (dmonad)](https://discuss.yjs.dev/t/whats-the-correct-way-to-set-default-content-for-y-prosemirror/1129)

Vendors keep rediscovering it: Liveblocks calls it
[the duplication problem](https://liveblocks.io/docs/guides/setting-an-initial-or-default-value-in-tiptap)
("add a default value [...] would instead be sent as an append command");
Tiptap's collab install warns that
["the initial content is repeatedly added each time the editor loads"](https://tiptap.dev/docs/collaboration/getting-started/install).

Both return the existing instance if this process already bound a Plexus to the doc.

Contagion (a child pushed onto a materialized parent lands in the same doc) is [lifecycle](./lifecycle.md).
This page is only how the root exists at all.
