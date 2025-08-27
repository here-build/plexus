# @dappsnap/plexus

> Constraint network for object state superposition through mathematical field dynamics

**Plexus** transforms traditional inheritance hierarchies into proxy networks where objects exist in quantum superposition until materialization collapses them into specific instances.

## Key Concepts

### Quantum Superposition Objects

Objects exist in two states simultaneously:
- **EPHEMERAL**: Local objects with full functionality, not synced
- **MATERIALIZED**: Same objects, now synced to YJS and shared across clients

The "contagion" happens when ephemeral objects touch the YJS graph: they automatically materialize (get entityId + sync) while preserving object identity.

### The Plexus Pattern

Instead of rigid inheritance chains, Plexus creates constraint networks where relationships emerge organically through mathematical propagation. Like neural plexus - interconnected field where state flows through constraint relationships rather than hierarchical commands.

## Installation

```bash
npm install @dappsnap/plexus
```

## Usage

### Basic Runtime Usage

```typescript
import { buildModelClass } from '@dappsnap/plexus';

// Define schema
const UserSchema = {
  name: "val",
  posts: "list",
  metadata: "record"
} as const;

// Create model class
const User = buildModelClass("User", UserSchema);

// Create ephemeral instance
const user = new User({
  name: "Alice",
  posts: [],
  metadata: {}
});

// Object exists in superposition until materialized via YJS
```

### Generator Usage

For codegen from schema DSL:

```typescript
import { writeProxyModelSchemas } from '@dappsnap/plexus/generator';

// Your schema parsing functions
import { parse, transform, MetaRuntime } from './your-schema-system';

await writeProxyModelSchemas(
  schemaString,
  'output/proxy-models.ts',
  parse,
  transform,
  MetaRuntime
);
```

## Exports

### Main Package (`@dappsnap/plexus`)
- `buildModelClass` - Core factory for creating model classes
- `ModelType` - TypeScript type for model instances
- All runtime types and symbols

### Generator (`@dappsnap/plexus/generator`)
- `generateProxyModelSchemas` - Core generator function
- `writeProxyModelSchemas` - Convenience wrapper
- Type interfaces for schema system integration

## Architecture

Plexus implements a constraint network that reveals object relationships through mathematical field dynamics instead of inheritance chains. The system:

1. **Creates object superposition** - Same reference, different behavior based on materialization state
2. **Enables seamless transitions** - No "upgrade" or replacement during ephemeral → materialized transition  
3. **Maintains identity preservation** - Objects remain themselves throughout state changes
4. **Provides automatic contagion** - Materialization spreads through object graphs organically

## Philosophy

> "Objects don't inherit behavior - they participate in constraint fields that determine their possibilities."

The mathematical beauty: objects exist in all possible states simultaneously until interaction collapses them into specific manifestations. Like quantum mechanics, but for TypeScript.

## Architecture: Ownership Tree + Living Graph

Plexus implements a hybrid structure combining hierarchical ownership with graph relationships:

### Core Model

- **Ownership Tree**: Hierarchical structure where nodes have zero or one parent, forming a tree of containment
- **Living Graph**: Fully connected graph including weak references and potentially detached nodes
- **Main Subgraph**: All nodes transitively reachable from root - these are "materialized" and synced
- **Detached Nodes**: Exist outside the main subgraph but remain in memory, can be re-attached

### Key Behaviors

**Reachability Determines Materialization**
- Nodes reachable from root are part of the main subgraph (materialized, synced)
- Detached nodes become ephemeral but aren't immediately destroyed
- Re-attaching a detached node to the tree re-materializes it instantly

**Bidirectional Materialization Contagion**
```typescript
ephemeralParent.child = materializedNode  // Both become materialized
materializedNode.parent = ephemeralParent  // Both become materialized
```

**Identity Semantics**
- Primitives and collections (sets, records): Structural identity
- Entities: Reference identity preserved by pointer

### Temporal Garbage Collection

Plexus uses temporal boundaries to resolve distributed GC challenges:

- Detached nodes remain valid and usable after detachment
- Server-side mark-and-sweep GC runs periodically
- Nodes unreachable for >1 week become eligible for collection
- Re-attachment resets the GC timer

This "eventual convergence" approach means:
- No immediate consistency requirements
- Users can work with detached subgraphs seamlessly  
- Temporary inconsistencies resolve through time
- The system naturally tends toward correctness

### Practical Implications

**For Developers**
- Clone operations create detached nodes by default
- Tree operations are destructive (delete parent → children detached)
- Graph operations are selective (remove reference → target remains)
- Detached nodes can be freely edited and later re-attached

**For Users**
- Deleted content has a 1-week grace period
- Undo/redo boundaries follow tree structure
- References to detached nodes remain valid
- No "stale reference" errors - everything eventually converges

## License

MIT
