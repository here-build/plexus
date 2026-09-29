---
title: Document lifecycle
description: Understand when a model joins a document, what detaching means, and why identity survives a move.
---

A local model is complete in its own environment: it has object identity, reactive fields, collections, and relationships. It can remain local for its entire lifetime. Joining a document enriches it with replicated state and identity that can be used across environments.

The local instance remains the same object. Existing references, parent-child relationships, and observers continue to work.

| Context | Capabilities |
| --- | --- |
| Local model | Object identity, fields, collections, ownership, references, and MobX reactivity |
| Model in a document | All local behavior, plus replicated state, a UUID, and document membership |
| Document with a provider | Exchange that state with other environments |

## A complete local model

Models support field reads, writes, collections, and ownership before they belong to a Yjs document. Using the `Project` and `Task` definitions from [From local to shared](/start/first-model/):

```typescript
const project = new Project({ name: "Draft" });
const task = new Task({ title: "Write the docs" });
project.tasks.push(task);

task.title = "Review the docs";
task.parent === project; // true; neither model needs a document yet
```

Locally, the instance itself provides identity: compare it with `===`, use it as a map key, or keep a reference to it. Parent-child relationships are useful here already; they do not require a shared document.

Properties that describe document context reflect its absence: `.rootAncestor` is `null` and `.isDetached` is `false`. Detachment describes reachability inside an existing document. [Identity & UUIDs](#identity--uuids) explains when cross-environment identity becomes relevant.

## Join a document

```typescript
const plexus = Plexus.bootstrap(project);

task.uuid;                      // now available
task.rootAncestor === project; // true
```

Bootstrapping the project materializes its owned tasks too. Materialization gives those existing objects a representation in the document. It preserves their JavaScript identity and existing observers. A new task pushed into the project later gains the same document context automatically.

The models now have replicated identities and state. A provider can exchange that state with other clients; materialization itself does not require a network connection.

An entity's document affiliation is permanent. Detaching it does not turn it back into a document-free object. The [doc-boundary law](#the-doc-boundary-law) also covers less common cases, such as constructing a new parent around a model that is already materialized.

## Detach and reattach

```typescript
task.detach();             // removes it from project.tasks
task.parent;               // null
task.isDetached;           // true
task.uuid;                 // unchanged

project.tasks.push(task);  // reattach within the same document
task.isDetached;           // false
```

Detaching an owner makes its owned subtree unreachable from the root. Plain references can still point to these models. See [Ownership and references](/guide/ownership/) for the distinction.

Use `.isRoot` to identify the document root and `.isDetached` to check whether a materialized model is unreachable through ownership from that root.

## Identity & UUIDs

Identity has a scope. In one environment, an object reference is enough to recognize a model, including as a key in a map or a member of a set.

Within a replica, Plexus preserves a model's JavaScript identity across materialization and subsequent lookups. Repeated lookups of the same entity return the same live instance. Other clients have their own instances of that entity.

Across environments, use `.uuid`: another process cannot use your JavaScript reference, but it can resolve the replicated identity. The UUID encodes the creating actor and logical clock. It becomes available when the model joins a document, before any provider needs to send its state to a peer.

Reading `.uuid` on a local, document-free model throws because it has no document representation to identify. The object already has the identity it needs for local use.

`.documentId` returns the Yjs document GUID, or `undefined` for an unmaterialized or dependency entity.

### `.localID` — process-local creation-order identity

Every model also has a `.localID` from the moment it is constructed. This number is local to the process and never serialized. It is useful when debug labels or deterministic test fixtures need a numeric creation-order identity.

| Surface | Scope | Available | Use for |
| --- | --- | --- | --- |
| `.uuid` | Replicated entity identity | After materialization | Cross-client references and storage |
| `.localID` | Process-local creation order | From construction | Tests, debug labels, local identity |
| `ordinal.id(obj)` from `@here.build/collections` | Process-local first-use order | Any object | Identity for objects outside Plexus |

`resetLocalIDs()` resets the model counter to 1 for tests. Use it only between tests: surviving models can otherwise collide with new IDs. This counter is separate from the ordinal protocol's counter; resetting it does not reset ordinal IDs.

## Clone an owned subtree

```typescript
const copy = task.clone({ title: "Another task" });
project.tasks.push(copy);
```

`.clone()` recursively copies owned children into new model instances. References to models inside the copied subtree are rebound to their copies. References to models outside that subtree keep pointing to the originals.

Choose the clone boundary accordingly: clone the owner containing all the objects you want copied together. Override or reassign external references explicitly when you need a different target.

**Cloning does not guarantee portability across documents.** References preserved from the source may still belong to its document. Trying to materialize those relationships in another document can throw `PlexusDocMismatchError`.

Adopting a referenced original into a new owning field is a move of that original. Within the same document, its previous owner releases it; across documents, adoption throws. The [clone implementation](https://github.com/here-build/plexus/blob/main/packages/plexus/src/clone.ts) explains the reference-rebinding rules in detail.

## Serialize model values

```typescript
const values = task.toJSON();
const json = JSON.stringify(task);
```

`toJSON()` returns a plain object containing schema fields. Use `.clone()` when you need another Plexus model with an owned subtree; a plain serialized value is no longer a live model instance.

## The Doc-Boundary Law

**Materialization is contagious.** A relationship can materialize both newly adopted children and newly constructed owners:

- A document-free child adopted by a document-backed parent joins the parent's document, with its reachable subtree.
- A document-free parent adopting a document-backed child joins the child's document. It can briefly be detached until another owner adopts it.
- Two document-free models can form a relationship while remaining local.
- Two models in the same document can reparent normally.
- Adoption between models already materialized in different documents throws `PlexusDocMismatchError`.

This makes **wrap-in-place** possible. Given a document-backed group tree:

```typescript
const leaf = root.groups.leaf;
root.groups.leaf = new Group({
  name: "wrapper",
  groups: { leaf },
});
```

The constructor adopts the existing leaf. The wrapper joins the leaf's document, then the assignment attaches the wrapper to the root. The leaf moves without changing its identity.
