# Plexus Error Handling Guide

## Quick Reference

All Plexus parent reassignment operations can throw specific error types. This guide shows how to handle them.

## Available Error Types

```typescript
import {
  PlexusCycleError,
  PlexusSelfAdoptionError,
  PlexusDependencyError,
  PlexusRootParentError,
  PlexusDocMismatchError,
  PlexusDuplicateChildError,
} from "@here.build/plexus";
```

## Error Handling Patterns

### Basic Type Checking

```typescript
try {
  node.childVal = anotherNode;
} catch (error) {
  if (error instanceof PlexusCycleError) {
    // Handle cycle error
    console.log("Cannot create cycle between:", error.child, error.newParent);
  } else if (error instanceof PlexusSelfAdoptionError) {
    // Handle self-adoption
    console.log("Cannot adopt itself:", error.entity);
  } else {
    // Re-throw unknown errors
    throw error;
  }
}
```

### Accessing Error Context

Each error type provides structured context:

```typescript
try {
  parent.childList.push(child);
} catch (error) {
  if (error instanceof PlexusCycleError) {
    // Access specific properties
    const childId = error.child.uuid;
    const parentId = error.newParent.uuid;
    const field = error.field;
    const cycleNode = error.cycleNode.uuid;

    console.log(`Cycle: ${childId} -> ${parentId} (detected at ${cycleNode})`);
  }
}
```

### Handling Multiple Error Types

```typescript
function safeAdopt(parent: Node, child: Node, field: string): boolean {
  try {
    switch (field) {
      case "childVal":
        parent.childVal = child;
        break;
      case "childList":
        parent.childList.push(child);
        break;
      // ... other fields
    }
    return true;
  } catch (error) {
    if (error instanceof PlexusCycleError) {
      console.error("Cycle would be created");
      return false;
    }
    if (error instanceof PlexusSelfAdoptionError) {
      console.error("Self-adoption not allowed");
      return false;
    }
    if (error instanceof PlexusDependencyError) {
      console.error("Cannot modify dependency entity");
      return false;
    }
    // Unknown error - re-throw
    throw error;
  }
}
```

### Error-Specific Recovery

```typescript
function tryAdoptWithFallback(parent: Node, child: Node): void {
  try {
    parent.childVal = child;
  } catch (error) {
    if (error instanceof PlexusCycleError) {
      // Try alternative approach: clone the child instead of adopting
      const clonedChild = child.clone();
      parent.childVal = clonedChild;
      console.log("Created copy to avoid cycle");
    } else if (error instanceof PlexusDocMismatchError) {
      // Handle cross-document case
      console.error("Entities from different documents:", {
        childDoc: error.child.__doc__?.clientID,
        parentDoc: error.newParent.__doc__?.clientID,
      });
      throw error; // Cannot recover
    } else {
      throw error;
    }
  }
}
```

## Error Types Reference

### PlexusCycleError

**Properties:**

- `child: PlexusModel` - Entity being adopted
- `newParent: PlexusModel` - Would-be parent
- `field: string` - Field name where adoption attempted
- `cycleNode: PlexusModel` - Node where cycle was detected

**Common Scenarios:**

- Creating circular references
- Moving nodes that would make parent a descendant

**Recovery Options:**

- Clone one entity to break cycle
- Restructure tree to avoid cycle
- Use different field/relationship

### PlexusSelfAdoptionError

**Properties:**

- `entity: PlexusModel` - Entity attempting to adopt itself
- `field: string` - Field name

**Common Scenarios:**

- `node.childVal = node`
- `node.childList.push(node)`

**Recovery Options:**

- None - self-adoption is never valid
- Check logic to prevent this case

### PlexusDependencyError

**Properties:**

- `entity: PlexusModel` - Dependency entity
- `operation: string` - Operation attempted (e.g., "adopted")

**Common Scenarios:**

- Trying to modify entity from imported project
- Attempting to change parent of dependency

**Recovery Options:**

- Clone the dependency if modification needed
- Use as read-only reference
- Import into current project properly

### PlexusRootParentError

**Properties:**

- `rootEntity: PlexusModel` - Root entity
- `attemptedParent: PlexusModel` - Invalid parent

**Common Scenarios:**

- Trying to give root entity a parent
- Moving root into tree structure

**Recovery Options:**

- None - root must remain at top level
- Check if entity is actually root before operation

### PlexusDocMismatchError

**Properties:**

- `child: PlexusModel` - Child entity
- `newParent: PlexusModel` - Parent from different doc

**Common Scenarios:**

- Mixing entities from different YJS documents
- Cross-document adoption attempts

**Recovery Options:**

- Clone entity into target document
- Keep entities in separate documents
- Merge documents if appropriate

### PlexusDuplicateChildError

**Properties:**

- `parent: PlexusModel` - Parent entity
- `field: string` - Field name
- `child: PlexusModel` - Duplicate child
- `operation: string` - Operation (push, unshift, splice)

**Common Scenarios:**

- `list.push(item, item)` - same item twice
- `list.splice(0, 0, item)` when item already in list

**Recovery Options:**

- Remove duplicates from input
- Check if item exists before adding
- Use Set semantics if duplicates not needed

## Verbose Logging

All errors automatically log detailed context to console.error. This happens BEFORE the error is thrown.

### Example Console Output

```javascript
Cycle detected during adoption: {
  child: 'Node#abc123',
  newParent: 'Node#def456',
  field: 'childVal',
  cycleNode: 'Node#abc123',
  currentParent: 'Root#root',
  stackTrace: 'PlexusCycleError: ...\n    at ...'
}
```

### Configuring Verbose Logs

Plexus provides a configurable logger. To disable or customize logging:

```typescript
import { setPlexusLogger } from "@here.build/plexus";

// Option 1: Disable all logging
setPlexusLogger("silent");

// Option 2: Use custom logger (consola, pino, etc.)
import consola from "consola";
setPlexusLogger(consola);

// Option 3: Filter specific messages
setPlexusLogger({
  error: (msg, ctx) => {
    // Only log cycle errors
    if (msg.includes("Cycle")) {
      console.error(msg, ctx);
    }
  },
  warn: (msg, ctx) => console.warn(msg, ctx),
  info: (msg, ctx) => console.info(msg, ctx),
  debug: (msg, ctx) => console.debug(msg, ctx),
});
```

See [Logger Configuration](./logger-configuration.md) for full details.

## Best Practices

### 1. Let Errors Propagate

Plexus errors contain valuable debugging information. Don't swallow them unnecessarily:

```typescript
// ❌ Bad: Hiding errors
try {
  node.childVal = child;
} catch {
  // Silent failure - hard to debug
}

// ✅ Good: Propagate with context
try {
  node.childVal = child;
} catch (error) {
  console.error("Failed to set child:", { node, child });
  throw error; // Re-throw with context
}
```

### 2. Use Specific Error Types

Catch specific types for specific recovery:

```typescript
// ❌ Bad: Generic catch
try {
  node.childVal = child;
} catch (error) {
  // Don't know what went wrong
  return null;
}

// ✅ Good: Specific handling
try {
  node.childVal = child;
} catch (error) {
  if (error instanceof PlexusCycleError) {
    return handleCycle(node, child);
  }
  throw error; // Unknown error
}
```

### 3. Validate Before Operations

Check conditions before attempting operations:

```typescript
// ❌ Bad: Try and catch
try {
  node.childVal = child;
} catch {
  // Error handling
}

// ✅ Good: Validate first (if possible)
if (child === node) {
  console.error("Cannot adopt self");
  return;
}
node.childVal = child;
```

Note: Cycle detection requires walking parent chain, so try/catch is often more practical than pre-validation for that
case.

### 4. Log Context

Add application context to error logs:

```typescript
try {
  updateNodeRelationship(parent, child, operation);
} catch (error) {
  if (error instanceof PlexusCycleError) {
    console.error("Relationship update failed:", {
      operation,
      userId: currentUser.id,
      timestamp: Date.now(),
      error,
    });
  }
  throw error;
}
```

## Testing Error Conditions

```typescript
import { expect } from "vitest";
import { PlexusCycleError } from "@here.build/plexus";

test("prevents cycle creation", () => {
  const parent = new Node();
  const child = new Node();

  parent.childVal = child;

  // Should throw PlexusCycleError
  expect(() => {
    child.childVal = parent;
  }).toThrow(PlexusCycleError);
});

test("provides error context", () => {
  const parent = new Node();
  const child = new Node();

  parent.childVal = child;

  try {
    child.childVal = parent;
    expect.fail("Should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(PlexusCycleError);
    if (error instanceof PlexusCycleError) {
      expect(error.child).toBe(child);
      expect(error.newParent).toBe(parent);
      expect(error.field).toBe("childVal");
    }
  }
});
```

## Summary

Plexus custom error types provide:

- **Type safety** - Catch specific error types
- **Rich context** - Access all relevant entity information
- **Verbose logging** - Automatic console.error with full details
- **Recovery options** - Handle errors appropriately per type

All errors are thrown BEFORE any state modification, ensuring tree consistency even when operations fail.
