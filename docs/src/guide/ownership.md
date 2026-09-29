---
title: Ownership and references
description: Give each object one owner while allowing other objects to point to it.
---

A group owns its blocks. An arrow references its endpoints. Both are relationships between models, but moving or detaching a group should affect its blocks differently from the arrows that point to them.

## Choose the relationship

| Relationship | Declaration | Behavior |
| --- | --- | --- |
| Ownership | `@syncing.child` and child collections | One parent; adopting into another parent removes the old ownership |
| Reference | `@syncing` and ordinary collections | Points at a model without taking ownership; cycles are allowed |

Ownership enriches a model with a parent-child structure: projects, pages, groups, and their contents. These relationships work locally and keep the same behavior when the model joins a document. Use references for links across that structure, shared definitions, and back-pointers.

## Move a child

This complete local example has two groups and a block. Moving the block updates its parent and both collections:

```typescript
import { PlexusModel, syncing } from "@here.build/plexus";

@syncing("Block")
class Block extends PlexusModel<Group> {
  @syncing accessor text = "";
}

@syncing("Group")
class Group extends PlexusModel<Board> {
  @syncing.child.list accessor blocks!: Block[];
}

@syncing("Board")
class Board extends PlexusModel {
  @syncing.child.list accessor groups!: Group[];
  @syncing accessor selected: Block | null = null;
}

const left = new Group();
const right = new Group();
const board = new Board({ groups: [left, right] });

const block = new Block({ text: "Move me" });
left.blocks.push(block);
board.selected = block;

right.blocks.push(block);

console.log(left.blocks.length);       // 0
console.log(block.parent === right);   // true
console.log(board.selected === block); // true

```

The move changes ownership. The block keeps its identity, and `selected` continues to reference it. The generic `PlexusModel<Group>` types the block's `.parent` accessor.

## Add a document when needed

To share this existing graph, continue the example:

```typescript
import { Plexus } from "@here.build/plexus";

const plexus = Plexus.bootstrap(board);
console.log(board.selected === block); // true; the same local object
console.log(block.parent === right);   // true; the same ownership
block.uuid;                           // shared identity is now available

plexus.destroy(); // when finished using the document
```

The document adds replicated state and UUIDs to the existing graph. A provider can now exchange its state with other environments. [From local to shared](/start/first-model/) demonstrates the transition with an observer and a second replica.

## Detach without losing identity

`block.detach()` removes the block from its owner. A detached model remains in its document and can still be referenced. Detaching a group makes its owned subtree unreachable from the root; plain references can still point into it.

Reattach a model by adopting it into another owner in the same document. See [Document lifecycle](/laws/lifecycle/) for the difference between a new, document-free model and a detached model.

## Respect the document boundary

Once materialized, an entity belongs to one document. Adopting it into a model in another document throws `PlexusDocMismatchError`. Detaching it does not remove that affiliation.

Ownership also rejects self-adoption, cycles, and parenting the document root. [Errors and troubleshooting](/guide/errors/) lists the error types and recovery guidance.

## Model collections

Child relationships support scalar accessors, lists, sets, records, and maps. In a child map, values are owned; keys are not. [Models and fields](/guide/fields/) covers the decorator forms and structural map keys.
