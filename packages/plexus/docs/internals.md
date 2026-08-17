## Internals

<!-- Two-doc routing — unpublished (same class as Liminality above). Do not unhide
     with the public README.

Every Plexus instance owns two Y.Docs. The entity tree binds and writes on the
**shadow** doc. The **main** doc is the committed store that syncs to peers.
Type-map scaffold, the root pointer, and dependency-map mutations write on main.

Transaction-origin symbols route updates (`Plexus.ts` header):

| Origin | Role | Undo |
|---|---|---|
| `SHADOW_TO_MAIN` | shadow write, forwarded to main under the same origin | main UM |
| `LIMINAL_ORIGIN` | shadow write, not forwarded | liminal UM |
| `COMMIT_DELTA_ORIGIN` | applied on main; shadow receives `FROM_MAIN` | main UM |
| `GENESIS_ORIGIN` | shadow write, forwarded to main as `FROM_SHADOW` | ignored |
| `FROM_SHADOW` | untracked stamp on the shadow→main hop (genesis, lazy containers); main drops it so the hop does not echo | ignored |
| `FROM_MAIN` | untracked stamp on the main→shadow hop (remote sync, commit echo, peer preview); shadow drops it so the hop does not echo | ignored |

Orientation map: `Plexus.ts` (routing, liminality, undo), `PlexusModel.ts` (materialization,
ownership), `decorators.ts` (`@syncing` field wiring), `awareness.ts` / `awareness-serde.ts`
(multi-channel presence), `field-awareness.ts` (per-field MobX lens), `genesis-client.ts`
(clientId namespaces, deterministic scaffold), `plexus-registry.ts` (doc↔plexus registries),
`tracking.ts` (MobX bridge), `deref.ts` (UUID → entity O(1) resolution).
-->

### The `/internals` entrypoint

```typescript
import { docPlexus } from "@here.build/plexus/internals";
```

The root export is what Plexus intends you to use. `@here.build/plexus/internals` is the same
package with **nothing withheld** — every registry, protocol symbol, wire codec and tracking
primitive the implementation runs on.

It exists because a library that hides the one handle you need leaves you forking it. Its
contents are deliberately not listed here: being undocumented is what keeps reaching for it a
deliberate act rather than a default.

**The specifier is the marker.** An import from `/internals` is an acknowledged violation of the
package's own ontology, in the sense `@ts-expect-error` acknowledges a type violation —
permitted, visible in the diff, and obliged to carry a reason at the call site. `docPlexus.get(entity.__doc__)`
is legal precisely because a Y.Doc is ontologically prior to the models bound to it; the call
site just has to say so. Do not wrap it in an accessor to make it comfortable — the friction is
the feature.
