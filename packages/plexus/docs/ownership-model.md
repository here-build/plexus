# Plexus Ownership Model

## Overview

Plexus uses a **single-owner tree model** for its data structures. This is enforced through a distinction between strong
references (ownership) and weak references (just pointers). This model provides clear lifecycle management, prevents
circular dependencies, and enables efficient serialization.

## Core Principles

### 1. Every Object Has Exactly One Owner

Every entity is "owned" by exactly one parent through a strong reference:

```typescript
// Parent OWNS its children
Parent
{
  children: Child[]      // Strong ref = ownership
}

// Container OWNS its content
Container
{
  content: Node          // Strong ref = ownership
}
```

### 2. Strong References Form a Tree

Strong references (non-WeakRef fields) must form a directed acyclic graph (DAG), specifically a tree:

- No cycles allowed
- Each object has exactly one path from the root
- Deleting a parent deletes all its owned children

### 3. Weak References Enable Cross-References

Weak references (`@WeakRef` annotated fields) can point anywhere in the tree without affecting ownership:

```typescript
Node
{
  parent ? : Node           // @WeakRef - back-pointer to parent
  linkedNode ? : Node       // @WeakRef - references but doesn't own
}
```

## The Ownership Rules

1. **Default is ownership**: Any field that references another model object is a strong ref (ownership) unless marked
   `@WeakRef`
2. **One owner only**: Each object can only be strongly referenced from one place
3. **Weak refs don't affect lifecycle**: Deleting an object doesn't affect objects it weakly references
4. **Tree traversal skips weak refs**: Prevents infinite loops and ensures each object is visited once

## Visual Example

```
Root
├─ items: Item[] ←────────────── Strong ref (OWNS)
│  ├─ Item A
│  │  ├─ props: Prop[] ←──────── Strong ref (OWNS)
│  │  └─ content: Node ←──────── Strong ref (OWNS)
│  │
│  └─ Item B
│     ├─ baseItem: Item A ←───── Weak ref (REFERENCES)
│     └─ content: Node
│        └─ children: Node[] ←── Strong ref (OWNS)
│           └─ Child Node
│              └─ parent: Node ← Weak ref (REFERENCES)
```

## Implementation Details

### Tree Traversal

When walking the model tree, weak references are skipped to maintain tree properties:

```typescript
function walkModelTree(node: PlexusModel, walked = new Set()) {
  walked.add(node);

  for (const field of getFields(node)) {
    if (isWeakRefField(field)) {
      continue;  // Skip weak refs to prevent cycles
    }
    // Recursively walk owned objects
  }
}
```

### Serialization

Strong and weak references are serialized differently:

```typescript
if (isWeakRefField(field)) {
  // Weak ref: serialize as reference pointer
  return { __ref: getAddress(value) };
} else {
  // Strong ref: serialize the entire object inline
  return serialize(value);
}
```

## Common Patterns

### Parent Back-References

Every child knows its parent through a weak ref:

```typescript
Node
{
  parent ? : Node  // @WeakRef
}
```

### Definition Reuse

Definitions are defined once and referenced many times:

```typescript
Instance
{
  definition: Definition  // @WeakRef to the definition
}
```

### Inheritance Hierarchies

Super-types are referenced, not owned:

```typescript
Type
{
  superType ? : Type  // @WeakRef
}
```

## Benefits

1. **Clear Lifecycle**: When you delete a container, all its owned parts are deleted
2. **No Memory Leaks**: No circular references means predictable cleanup
3. **Efficient Serialization**: Each object is serialized exactly once
4. **Safe Tree Operations**: Can traverse without worrying about cycles
5. **Easier Reasoning**: Clear ownership makes the model easier to understand

## Comparison to Other Models

This is similar to:

- **Rust's Ownership**: One owner, many borrowers
- **Swift's Strong/Weak References**: But applied to data modeling
- **React's Component Tree**: Props flow down, refs for cross-tree access

## Guidelines for New Fields

When adding a new field that references another model object, ask:

1. **Does this field represent ownership?** → Use strong ref (default)
2. **Is this just a pointer to something owned elsewhere?** → Use `@WeakRef`
3. **Would including this in tree traversal create a cycle?** → Use `@WeakRef`
4. **Should deleting the parent delete this?** → Strong ref if yes, weak ref if no
