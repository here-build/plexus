### Virtual Maps

> **Advanced / niche.** There's one more syncing type - `@syncing.virtual(factory)` - that solves one specific CRDT conflict: concurrent spawn of "the same" entity by multiple peers. A deterministic genesis actor creates the child identically for everyone, so merges converge instead of duplicating. It is **not** a lazy-load mechanism — reach for it only when you hit that conflict class. Mechanism, key rules, and constraints: [virtual-maps.md](./virtual-maps.md).

### `syncing.declare<Out, In>()`

> **Advanced / niche.** Unless you've encountered TS in/out problem, you will not need this section. Feel free to skip - it's here for ones who are struggling already.

A void decorator extension exists solely to declare generic type parameters for TypeScript variance narrowing.
Needed when a generic model like `ExprSequence<A, B>` must interact with `ExprSequence<NarrowerA, any>`
but not `ExprSequence<NarrowerA, NarrowerB>` — without it, TypeScript infers overly strict variance and blocks valid assignments:

```typescript

@syncing("ExprSequence")
class ExprSequence<A extends Expr, B extends Expr> extends PlexusModel {
  @syncing.declare<A, Expr>() accessor head!: A;
  @syncing.declare<B, Expr>() accessor tail!: B;
}
```

**Lazy Containers**: Empty collection fields (lists, sets, records, maps) cost zero in the CRDT log until first write.
The container is materialized on demand with a deterministic identity that converges across independent peers.

**Singleton Guarantee & `O(1)` Entity Caching**: Plexus maintains an internal `WeakRef` cache of all materialized entities.
When querying nested models or resolving dependencies, you receive **the exact same TypeScript class instance in memory**.
Navigating to a model or calling `plexus.loadEntity(uuid)` performs an `O(1)` memory lookup rather than a binary search
traversing the `Y.StructStore` for entities you have already encountered.
This ensures that `entityA === entityB` strict equality checks function correctly across your application
while drastically minimizing overhead.
