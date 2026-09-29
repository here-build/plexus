---
title: Errors and troubleshooting
description: Recognize invalid operations and diagnose missing synchronization.
---

## A client does not see the document

Check the data flow in order:

1. Both clients connect to the same server and room.
2. Both load the same model definitions before calling `connect`.
3. One creator has seeded the shared document.
4. The joining client has received the initial state before it calls `connect`.

A `no root found, await sync first` error means the local document has no Plexus root yet. It may still be loading, or the room may never have been created. Avoid bootstrapping an empty client as a fallback: that can create a second root. Follow [Connecting clients](/start/connecting-clients/).

## A move throws a document mismatch

An entity keeps its document affiliation after detaching. Moving it to an owner in another document throws `PlexusDocMismatchError`. Reattach it within the same document, or explicitly construct the destination data with references valid there. Cloning a graph with references to the source document does not automatically make it portable.

See [Ownership and references](/guide/ownership/) and [Document lifecycle](/laws/lifecycle/).

## A field does not behave as expected

Use a decorated `accessor`, register each model class with `@syncing("Name")`, and keep type names unique across the model registry. Use collection decorators for collections and `.child` for owning relationships. A plain reference does not adopt its target.

For reactive updates, read the field inside a MobX `autorun`, `reaction`, or an observing UI component. Reading a value once outside an observer does not subscribe to subsequent changes.

## Error Types

Plexus throws specific error types with detailed console logging for ownership violations:

| Error | When |
| --- | --- |
| `PlexusSelfAdoptionError` | Entity tries to adopt itself |
| `PlexusCycleError` | Adoption would create a cycle in the ownership tree |
| `PlexusDependencyError` | Attempting to modify a dependency entity |
| `PlexusRootParentError` | Attempting to set a parent on the root entity |
| `PlexusDocMismatchError` | Adopting an entity already materialized in a *different* doc — entities never change docs |
| `PlexusDuplicateChildError` | Same child appears twice in a child array/set |
| `PlexusTypedArrayAliasError` | A typed-array member would hand back a live view onto the CRDT-tracked buffer (`subarray()`, `.buffer`) — take `.slice()` for a detached copy; mutate in place to sync |
| `PlexusUnstorableValueError` | Writing a value yjs cannot store to a synced field (function, symbol, `Map`/`Set`, class instance) — allowed: primitives, `Uint8Array`, plain JSON, model references |
