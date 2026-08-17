## Tree Walking

Schema-aware child traversal inspired by [zimmerframe](https://github.com/Rich-Harris/zimmerframe):

```typescript
import { walk, buildVisitor } from "@here.build/plexus";

walk(root, initialState, {
  Project(node, ctx) {
    // visit Project nodes
    ctx.next(); // continue to children
  },
  Page(node, ctx) {
    ctx.stop(); // halt traversal
  }
});
```

`walkChildren(node, state, visitors)` walks only direct children.
`buildVisitor(visitors)` creates a type-safe visitor for reuse.
