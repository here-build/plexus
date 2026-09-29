---
title: Undo and redo
description: Reverse content changes through the Plexus document, and group related edits into one action.
---

## Reverse an edit

Use the Plexus wrappers for document history:

```typescript
plexus.undo();
plexus.redo();
```

The wrappers manage internal tracking during replay, so changes caused by undo and redo are not themselves recorded as new undoable edits. Use them instead of calling the underlying Yjs `UndoManager` directly.

## Group a user action

A synchronous `@syncing.action` method groups its changes into one undo unit per document it touches:

```typescript
import { PlexusModel, syncing } from "@here.build/plexus";

@syncing("Task")
class Task extends PlexusModel {
  @syncing accessor title = "";
  @syncing accessor done = false;

  @syncing.action
  finish(title: string) {
    this.title = title;
    this.done = true;
  }
}
```

Call the method on a model in a document. Ordinary edits use the underlying undo manager's 500 ms capture window. [Reactivity and transactions](/guide/time/) explains action boundaries, synchronous execution, and crash behavior.

## What history records

Content changes are reversible. Structural bookkeeping, such as creating entity shells and materializing collection containers, is excluded from history. Undoing a content edit does not erase the underlying entity's identity.

Undo is also separate from rollback: an undo happens after a change, while a matching `rollbackIf` condition can discard a buffered action before it is broadcast. See [action crash behavior](/guide/time/#action-crash-behavior).
