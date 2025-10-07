# Plexus Awareness API

**Semantic collaboration across incompatible interface modalities**

## Core Principle

Track **WHAT** (entity) and **WHY** (operation), not **WHERE** (pixels).

Spatial data is optional and modality-specific. This enables collaboration between:
- Visual builder (spatial, mouse-driven)
- MCP/AI (non-spatial, programmatic)
- Code editor (line-based spatial)
- CLI tools (non-spatial)
- Mobile (touch-based spatial)
- Future unknown modalities

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Semantic Layer (universal)                         │
│  - focus: EntityId                                  │
│  - selection: Array<{entity, span?}>                │
│  - interaction: {type, entities}                    │
└─────────────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
┌───────▼──────┐ ┌──────▼─────┐ ┌──────▼─────┐
│ Visual       │ │ MCP        │ │ Code       │
│ Builder      │ │ (no cursor)│ │ Editor     │
│              │ │            │ │            │
│ cursor at    │ │ "AI editing│ │ highlight  │
│ (500, 300)   │ │ property"  │ │ line 50-60 │
└──────────────┘ └────────────┘ └────────────┘
```

Each app interprets semantic presence differently in its own modality.

## Quick Start

### 1. Declare Semantic Boundaries

```tsx
import { ViewportSegment, PresenceBoundary } from '@here.build/plexus/awareness';

<ViewportSegment id="canvas">
  {components.map(comp => (
    <PresenceBoundary entityId={comp.id}>
      <ComponentRenderer component={comp} />
    </PresenceBoundary>
  ))}
</ViewportSegment>
```

### 2. Query Presence

```tsx
import { usePresenceInEntity } from '@here.build/plexus/awareness';

function ComponentHighlight({ entityId }) {
  const presence = usePresenceInEntity(entityId);

  return (
    <div className={presence.isFocused ? 'highlighted' : ''}>
      {presence.users.map(user => (
        <UserBadge key={user.userId} user={user} />
      ))}
    </div>
  );
}
```

### 3. Update Your Presence

```tsx
import { useUpdatePresence } from '@here.build/plexus/awareness';

function Canvas() {
  const updatePresence = useUpdatePresence();

  const handleClick = (entity) => {
    updatePresence({ focus: entity.id });
  };

  const handleSelectionChange = (entities) => {
    updatePresence({
      selection: entities.map(e => ({ entity: e.id }))
    });
  };
}
```

## Key Concepts

### Semantic State (Core)

The essential presence information that transcends modalities:

- **focus**: Primary entity of attention (can be null)
- **selection**: Entities selected for manipulation (can be multi-entity)
- **interaction**: Current temporal operation (drag, edit, etc.)

### Spatial State (Optional)

Only for spatial modalities (visual builder, canvas):

- **pointer**: Cursor/touch position in segment coordinates
- **viewport**: View transform (zoom, pan, scroll)

AI/MCP has no spatial state - only semantic.

### Segments

Distinct UI spaces with their own coordinate systems:

- Visual builder: `canvas`, `tree`, `code`, `inspector`
- MCP: `read`, `edit`, `generate` (operation contexts, not spatial)
- Code view: `editor`, `diff`, `search`

Cross-segment collaboration works because semantic state is universal.

### Spans

Metadata about **what part** of an entity:

```typescript
// Text selection
{ type: 'text', start: 10, end: 20 }

// Property editing
{ type: 'property', path: 'backgroundColor' }

// List items
{ type: 'items', indices: [0, 2, 7] }

// Code lines
{ type: 'lines', start: 50, end: 60 }
```

Enables fine-grained conflict detection across modalities.

## Advanced Usage

### Follow Mode

```tsx
const { startFollowing, stopFollowing } = useFollowMode();

// Follow Alice - viewport syncs to her focus
startFollowing('alice');

// Auto-unfollow on local navigation
stopFollowing();
```

### Conflict Detection

```tsx
useConflictDetection((conflict) => {
  if (conflict.severity === 'hard') {
    showError(conflict.message);
    cancelMyOperation();
  } else {
    showWarning(conflict.message);
  }
});
```

### Custom Presence Rendering

```tsx
<PresenceBoundary entityId="Button_X">
  {({ isFocused, users, activeOperations }) => (
    <div className={isFocused ? 'focused' : ''}>
      {activeOperations.includes('drag') && <DragIndicator />}
      <UserAvatars users={users} />
      <Button />
    </div>
  )}
</PresenceBoundary>
```

## Configuration

```tsx
const config: AwarenessConfig = {
  tickRate: 150,              // Broadcast frequency (ms)
  idleTimeout: 60000,         // Mark idle after 60s
  cleanupTimeout: 300000,     // Remove after 5min idle
  transitionDuration: 150,    // Follow mode animation
  transitionTiming: 'ease-out',
  followPadding: 50,          // Padding around focus
  followMaxZoom: 1.0,         // Max zoom in follow mode
};
```

## Why This Design?

Traditional spatial awareness (cursors, viewports) breaks down when:
- AI has no cursor position
- CLI has no viewport
- Mobile has different spatial semantics
- Future modalities are unknown

**Semantic awareness** transcends interface:
- Everyone sees **what entities** others engage with
- Each app renders presence **appropriate to its modality**
- Conflict detection works **across incompatible UIs**

This enables MCP (AI) and visual builder to collaborate on the same project, even though they have completely different interaction paradigms.

## Files

- `types.ts` - Core presence state and span types
- `config.ts` - Configuration types
- `components.ts` - React boundary/segment components
- `hooks.ts` - React hooks for querying/updating presence
- `conflicts.ts` - Conflict detection types
- `index.ts` - Re-exports all types

## Status

**Current**: API design phase (types only, no implementation)

**Next**: Implementation of awareness provider and hooks
