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
  metadata: "map"
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

### Runtime Only (`@dappsnap/plexus/runtime`)
- Focused exports for runtime-only usage
- Same as main package but more explicit

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

## License

MIT