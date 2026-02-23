# Atomic and Raw Field Decorators

**Status**: `syncing.atomic` - ready to implement | `syncing.raw` - deferred

## Problem Statement

Plexus currently restricts field values to `AllowedPrimitive | PlexusModel`:

```typescript
type AllowedPrimitive = string | number | boolean | bigint | null;
type AllowedYJSValue = AllowedPrimitive | PlexusModel;
```

This is intentional - Plexus provides CRDT semantics for these types with automatic merging, parent tracking, and
reactivity. However, this restriction blocks two legitimate use cases:

1. **Plain objects that should be stored atomically** (LWW, no field-level merging)
2. **Direct YJS type access** for editor integrations

## Proposed Solution: Two New Decorators

### `syncing.atomic` - Opaque LWW Storage

**Semantics**: "I don't care about merging internals; store this as an opaque blob with last-write-wins."

```typescript
@syncing
class UserPreferences extends PlexusModel {
  @syncing.atomic accessor theme: {
    colorScheme: "light" | "dark";
    fontSize: number;
    fontFamily: string;
  } = { colorScheme: "dark", fontSize: 14, fontFamily: "system-ui" };

  @syncing.atomic accessor cachedLayout: DOMRect | null = null;
}
```

**Why this exists**: YJS already stores plain objects atomically with LWW semantics. Plexus just type-blocks it.
`syncing.atomic` unlocks what YJS already does.

**Use cases**:

- Configuration objects where partial merges would create invalid states
- Cached/computed values that should be replaced wholesale
- Serialized external data (e.g., editor state snapshots)
- Any structure where concurrent field-level edits are meaningless

**What it's NOT**:

- Not for data that benefits from CRDT merging (use PlexusModel for that)
- Not for large binary data (consider external storage + reference)

### `syncing.raw` - Direct YJS Access

**Semantics**: "I know YJS internals; give me the raw type for black magic."

```typescript
@syncing
class Document extends PlexusModel {
  @syncing accessor title: string = "";

  @syncing.raw accessor content: Y.Text;  // For binding to Slate/ProseMirror/Monaco
  @syncing.raw accessor xmlContent: Y.XmlFragment;  // For XML-based editors
}
```

**Why this exists**: Rich text editors (Slate, ProseMirror, Quill, Monaco) have native YJS bindings that expect raw
`Y.Text` or `Y.XmlFragment`. Wrapping these in Plexus proxies would break the bindings.

**Use cases**:

- Rich text editor integration
- Code editor integration
- Any library with native YJS support
- Advanced CRDT operations that need direct YJS API access

**What it's NOT**:

- Not for general data storage (no Plexus reactivity, no parent tracking)
- Not a way to bypass Plexus safety (you lose guarantees)

## Implementation Notes

### `syncing.atomic`

Minimal implementation - mostly type-level:

1. Expand `AllowedYJSValue` or create parallel `AllowedAtomicValue` type
2. Setter passes value directly to YJS (already works)
3. Getter returns value directly from YJS (already works)
4. No proxy wrapping, no child tracking

Type constraint options:

- `JsonValue` - safe, portable, limited
- `StructuredCloneable` - handles Date, Map, Set, ArrayBuffer
- `unknown` - maximum flexibility, user responsibility

### `syncing.raw`

Requires YJS type creation/management:

1. On initialization, create the appropriate Y.Type
2. Store in `yjsModel` like other fields
3. Getter returns the Y.Type directly (no deref, no proxy)
4. No setter - mutations go through the Y.Type API

Open question: How to specify which Y.Type?

- Option A: Generic `syncing.raw<Y.Text>`
- Option B: Explicit `syncing.raw.text`, `syncing.raw.xml`, `syncing.raw.array`
- Option C: Infer from default value type

## Semantic Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     Plexus Field Types                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  @syncing accessor          Full Plexus: reactivity, tracking,  │
│                             CRDT merging, parent relationships  │
│                                                                 │
│  @syncing.atomic accessor   Plexus-managed, YJS-native storage  │
│                             Reactivity yes, merging no (LWW)    │
│                                                                 │
│  @syncing.raw accessor      Direct YJS access, no Plexus layer  │
│                             For editor bindings & advanced use  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Relation to null/undefined Semantics

These decorators follow the same null/undefined distinction as other Plexus fields:

- `undefined` = field not set / no awareness
- `null` = explicitly set to nothing

For `syncing.atomic`:

```typescript
config = undefined;  // Field doesn't exist in storage
config = null;       // Field exists, explicitly empty
config = {};         // Field exists with empty object (different from null!)
```

## Migration Path

Existing code storing objects via workarounds (JSON.stringify, etc.) can migrate:

```typescript
// Before: manual serialization
@syncing accessor configJson: string = "{}";
get config() { return JSON.parse(this.configJson); }
set config(v) { this.configJson = JSON.stringify(v); }

// After: native atomic storage
@syncing.atomic accessor config: ConfigType = {};
```
