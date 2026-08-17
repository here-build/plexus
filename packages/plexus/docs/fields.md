## Defining Models

### Primitive Fields

```typescript

@syncing("Project")
class Project extends PlexusModel {
  // note that you only can use accessors, not values - TS will prohibit non-accessor declarations
  @syncing accessor title: string = "";
  @syncing accessor owner: User | null = null;
  @syncing accessor createdAt: Date = new Date();

  // Computed properties work as expected. It's just JS.
  get titleUpperCase() {
    return this.title.toUpperCase();
  }
}
```

**Supported value types:** `string`, `number` (including `Infinity`, `-Infinity`, `NaN`), `boolean`, `null`, `bigint`, `Date`,
`Uint8Array`, and `PlexusModel` references.

Note that `undefined` is not supported and will be coerced to `null`.

> Why? It is impossible to properly track the constructor finishing its job without breaking lots of things.
> It means that we cannot track the default value assignment. 
> 
> As a consequence, it means that we cannot differ default value assignment in constructor and post-constructor assignment;
> saying "undefined means absence of value,
> null means empty value" lets us solve several edge cases around default value vs value intentionally passed in constructor. 

### Collection Fields

```typescript

@syncing("Project")
class Project extends PlexusModel {
  @syncing.list accessor members: User[]; // you may skip struct declarations
  @syncing.set accessor tags: Set<string> = new Set(["default-tag"]); // or declare defaults explicitly 
  @syncing.record accessor metadata: Record<string, string>;
  @syncing.map accessor scores: Map<User, number>;
}
```

**In-place Mutative Diffing**: Plexus performs diffing under the hood when you overwrite a collection.
Reassigning a collection field (e.g. `project.tags = new Set(["a", "b"])`) does not create a new CRDT node and destroy the old one.
Instead, it intelligently performs a granular diff (`add`/`delete` operations) against the existing CRDT node,
maintaining the underlying struct identity and preserving observers and object pointers. And - yes, Set has its own internal optimized behavior; it's not an Array under the hood.

### Child Fields (Ownership)

Use `.child` decorators for parent-child relationships with automatic reparenting.
Child fields confer ownership — a child can only have one parent at a time.

You can constrain the possible parents by passing the generic into the inheritance chain, like that: `extends PlexusModel<Project>`.

```typescript

@syncing("Project")
class Project extends PlexusModel<null> {
  @syncing.child.list accessor pages: Page[];
  @syncing.child.set accessor components: Set<Component>;
  @syncing.child.record accessor configs: Record<string, Config>;
  @syncing.child.map accessor assignments: Map<string, Task>;
  @syncing.child accessor activePage: Page | null = null;
}

// PlexusModel<Parent> types the .parent accessor
@syncing("Page")
class Page extends PlexusModel<Project> {
  @syncing accessor name: string = "";
}
```

Reverse relation can be resolved fia `.parent`, `.parentField` and `.parentFieldKey` (for list, record and map parentship).

```typescript
entity.parent;          // parent model instance, or null
entity.parentField;     // field name on parent (e.g. "pages"), or null
entity.parentFieldKey;  // key within field: string for records, deserialized
                        // ReadonlySet/readonly array for map keys, or null
entity.rootAncestor;    // walks up parent chain to find Plexus root, or null
```

Moving a child to a new parent **automatically removes it from the old one**:

```typescript
const page = new Page({ name: "homepage" });
project1.pages.push(page);    // page.parent === project1
project2.pages.push(page);    // page.parent === project2, project1.pages is empty
```

> **Child or plain reference?** A model-valued field is either owning (`.child` — one parent only,
detaching the parent takes the subtree with it, cycles forbidden) or a plain reference
(`@syncing` — a pointer to something owned elsewhere; lifecycle-neutral, cycles fine).
Use `.child` when deleting the parent should delete the value; use a plain reference for
back-pointers, definition reuse, and anything that would otherwise create an ownership cycle.

### Map Keys

Maps use structural equality for keys — Sets, Arrays, Dates, tuples, and PlexusModel references all work:

```typescript
@syncing.map accessor byDimensions: Map<Set<string>, number> = new Map();

// Order doesn't matter for Set keys
map.set(new Set(["a", "b"]), 42);
map.get(new Set(["b", "a"])); // 42

// Arrays/tuples are order-sensitive
@syncing.map accessor events: Map<[Date, string], Event> = new Map();

// Models as keys
@syncing.map accessor scores: Map<User, number> = new Map();
```

This **differs** from native JS `Map` behavior **intentionally**.
Pointer-reference maps are meaningless in collaborative environments.
Structural equality, however, enables powerful many-to-one relations (they can be named as quazi-hyperedges, if you like words like "hyperedge") like `Map<Set<User>, Group>`. Only flat structures are supported - `["a", ["b", "c"], new Set("d")]` just will not be accepted as valid map key.

> Why objects are not supported as keys?
> 
> Objects are somewhat indeterministic; it's hard to say - does keys order matter? What about getters?
> What about non-enumerables? Do empty fields matter? It's hard to make those behaviors expected for everyone.
> Array and Set, however, are explicit: one is saying "order matters", another "order do not matter".

Note that only Map class is supported, not its descendants.
Classes that extend Map will be serialized into key-value pairs and re-materialized as Map field.
TypeScript cannot detect that, sadly.
