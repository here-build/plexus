## Constructor Patterns

### PlexusInit & Constructor Shape

Models accept a props object, used as an initialization structure. You have to declare them manually:

> Why? TS is not capable to make constructor depend on instance fields.

```typescript

@syncing("MyModel")
class MyModel extends PlexusModel {
  @syncing accessor name!: string;

  constructor(props: { name: string }) {
    super(props); // PlexusInit<this> | undefined
  }
}
```

### Omittable Fields

Nullable fields and collections can be omitted from constructors:

```typescript

@syncing("Project")
class Project extends PlexusModel {
  @syncing accessor title!: string;                // Required
  @syncing accessor description!: string | null;   // Omittable (nullable)
  @syncing.list accessor tags!: string[];           // Omittable (spawns empty)
}

new Project({ title: "Hello" }); // Only title is required
```

### Accessor Syntax

Use `!: Type | null` for nullable fields. The `= null` initializer is equivalent:

```typescript
class {
  // Both are equivalent:
  @syncing accessor owner!: User | null;
  @syncing accessor owner: User | null = null;
}
```

## Inheritance

`@syncing` is required on every level of the class hierarchy.
Pass a string to set the model name (used for CRDT type maps and cross-peer resolution):

```typescript

@syncing("SuperProject")
class SuperProject extends Project {
  // field types can be redefined in subclasses
  // @ts-expect-error - it IS typescript error, but we allow overwriting child to non-child vice-versa.
  @syncing.child accessor title: string | RichName = "";
}
```

The `declare` TS keyword enables type narrowing without adding syncing behavior:

```typescript

@syncing("ConcreteGroup")
class ConcreteGroup extends AbstractGroup {
  declare items: SpecificItem[]; // Narrows type, no decorator needed
}
```
