# @here.build/plexus

JavaScript objects with reactivity, automatic sync, and parent/child relationships. Built on YJS for conflict-free collaboration.

## The Problem

JavaScript objects are missing critical features for modern apps:
- **No reactivity** - Manual UI updates everywhere
- **No relationships** - Objects don't know their parents or children
- **No sync** - Manual serialization and merge conflicts
- **No collaboration** - Every app reinvents real-time sync

## The Solution

Plexus makes objects work properly:

```typescript
// Regular JS - isolated, static, local
const component = { name: "Button", props: {} };

// Plexus - reactive, related, synced
const component = new Component({ name: "Button" });
component.name = "Submit";        // UI updates automatically
component.parent;                  // Knows its container
// Changes sync to all clients via YJS
```

## Core Features

### 🔄 MobX-Style Reactivity
Objects automatically trigger UI updates when modified. No more manual setState or event emitters.

### 🌳 Parent/Child Relationships
Objects know their position in the tree. Navigate up with `.parent`, down with `.children`. Full tree awareness built-in.

### 🔀 YJS-Powered Sync
Changes automatically sync across all clients using YJS (best-in-class CRDT). No conflicts, no manual merging, just works.

### 🎭 Ephemeral/Materialized States
Objects start local (ephemeral) and become synced (materialized) when attached to the tree. Same object reference throughout.

## Installation

```bash
npm install @here.build/plexus
```

## Usage

### Defining Models

```typescript
import { PlexusModel, syncing } from '@here.build/plexus';

@syncing
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor width!: number;

  constructor(props) {
    super(props);
  }
}

@syncing
class Container extends PlexusModel {
  @syncing
  accessor name!: string;

  // Children with automatic parent tracking
  @syncing.child.list
  accessor children!: Component[];

  @syncing.child.map
  accessor components!: Record<string, Component>;

  constructor(props) {
    super(props);
  }
}
```

### Creating and Syncing Objects

```typescript
import * as Y from 'yjs';
import { Plexus } from '@here.build/plexus';

// Step 1: Create ephemeral objects (local, not synced)
const button = new Component({ name: "Button", width: 100 });
const form = new Container({
  name: "Form",
  children: [button],
  components: {}
});

// Step 2: Initialize Plexus with YJS doc
const doc = new Y.Doc();
const plexus = new Plexus(doc);

// Step 3: Set as root - triggers materialization (now synced!)
const metadata = doc.getMap('__metadata__');
metadata.set('root', form.uuid);

// Step 4: Objects are now synced across all clients
form.name = "LoginForm"; // This change syncs everywhere
button.width = 200;       // This too

// Parent tracking works automatically
console.log(button.parent === form); // true
```

### Decorator Options

- `@syncing` - Makes a class syncable
- `@syncing` on field - Syncs the field value
- `@syncing.child` - Single child with parent tracking
- `@syncing.child.list` - Array of children with parent tracking
- `@syncing.child.set` - Set of children with parent tracking
- `@syncing.child.map` - Map of children with parent tracking

## Key Exports

```typescript
import {
  // Core classes
  PlexusModel,      // Base class for all models
  Plexus,           // Main orchestrator

  // Decorators
  syncing,          // Makes classes and fields syncable

  // Types
  YJS_GLOBALS,      // Constants for YJS integration
  referenceSymbol,  // Symbol for entity references

} from '@here.build/plexus';
```

## Important: Networking Not Included

Plexus handles object synchronization through YJS, but **you need to provide**:
- WebSocket server (we use PartyKit)
- YJS provider for network sync
- Persistence layer for Y.Doc states
- Room management and authorization

For production use, Plexus works best as part of a complete system like here.build that provides these services.

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
