## API Reference

```typescript
// ── Plexus ──
const plexus = Plexus.bootstrap(root, documentId?, doc?);
const plexus = Plexus.connect(existingDoc);

plexus.root;                                // root model
plexus.doc;                                 // underlying Y.Doc
plexus.loadEntity<T>(uuid);                 // entity by UUID
plexus.getAllOfType(Constructor);           // all instances of type
plexus.parentsOf(node, ParentClass, field); // reverse lookup
plexus.transact(fn);                        // batched transaction
plexus.undo();
plexus.redo();
```
<!--
plexus.enterLiminality();                   // ephemeral session
plexus.commitLiminality();                  // one atomic undo step
plexus.revertLiminality();                  // discard
plexus.isLiminal;
-->
```typescript
// ── PlexusModel<Parent> — Parent types .parent; construct with PlexusInit<this> ──
entity.localID;                             // process-local creation order; always present; never serialized
entity.uuid;                                // CRDT identity; throws before materialization
entity.documentId;                          // Y.Doc guid; undefined if unmaterialized / dependency
entity.parent;                              // owning parent, or null
entity.parentField;                         // field name on parent, or null
entity.parentFieldKey;                      // key inside that field, or null
entity.rootAncestor;                        // walk to Plexus root, or null
entity.isRoot;
entity.isDetached;                          // materialized and unreachable from root; ephemeral is not
entity.detach();                            // remove from parent; stays in doc; true if it was attached
entity.clone(overrides?);                   // deep clone of owned subtree
entity.toJSON();                            // plain object of schema fields
entity.parentsOf(ParentClass, field);       // yield parents that hold this entity in field
Model.modelName;                            // registered type name
Model.schema;                               // field → kind
```
```typescript
// ── @syncing — stage-3 accessors only; @syncing("Name") required every hierarchy level; names unique ──
@syncing("Name")
class Model extends PlexusModel<Parent> {
  @syncing accessor title: string;                    // val: primitive or model reference; undefined → null
  @syncing.list accessor items: Item[];               // Array; reassignment diffs in place
  @syncing.set accessor tags: Set<string>;
  @syncing.record accessor meta: Record<string, string>;
  @syncing.map accessor scores: Map<User, number>;    // structural keys
  @syncing.child accessor active: Page | null;        // owning scalar; one parent; reparent removes from old
  @syncing.child.list accessor pages: Page[];         // owning Array; children unique
  @syncing.child.set accessor comps: Set<Comp>;
  @syncing.child.record accessor configs: Record<string, Config>;
  @syncing.child.map accessor byId: Map<string, Task>; // values owned, keys not
  @syncing.virtual((k) => new Slot({ k }))
  accessor slots: VirtualMap<K, Slot>;                // .get(key) materializes; mutations throw; needs doc
  @syncing.declare<Out, In>() accessor head: Out;     // TS variance only; runtime = @syncing
  // every field decorator also has .declare<Out, In>()

  @syncing.action doStuff() {}                        // one update + undo unit per doc; commit-on-crash
  @syncing.action({ rollbackIf }) risky() {}          // matching throw discards the batch
}
```
