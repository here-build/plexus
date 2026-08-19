# Plexus history — intent / describing / operations

> Entry point. Design + an active build (2026-06-24). Open decisions are V's call.
> **Current architecture → [`lens-architecture.md`](./lens-architecture.md)** — object × facet × typed-coordinate
> (supersedes the area-centric framing; "not whole, but closer"). Detail docs:
> [`intent-lens-design.md`](./intent-lens-design.md) (the area-centric describing-layer blueprint — *reframed*) ·
> [`operations-layer.md`](./operations-layer.md) (operations vocabulary + reconciliation) ·
> [`intent-lens-hardening.md`](./intent-lens-hardening.md) (the adversarial corrections).

---

## 1. The state, honestly

The two-layer architecture is **sound and survives 9 areas of adversarial verification** against
the model source and `core/src/lift.ts` — core stays CRDT-blind (`PlexusChange[]`), the lens holds
all here.build semantics. The disposition frame (EMIT-anchor / MERGE-children / DROP-defaults, with
`FRESH`-by-cut as the birth discriminator) is the right shape; every kill in the hardening pass is a
*correction or addition* to the rules, never a rejection of the frame. The describing-layer skeleton
is solid. The operations layer is a **real reveal** — deriving the total forward vocabulary surfaced
that **most project mutations have no named verb today** (they happen as direct `studioCtx.transact()`
writes in panels, or as importer/sync side-effects). But the describing layer **is gated on five
core-lift widenings** and the wave-1 doc **oversold totality and shipped a fabricated flagship**.
Fed real input today it would leak raw uuids / raw values / keyless "something changed" noise across
Styling, Tokens, Behavior, and Collaboration. **Architecturally sound, not shippable as drawn —
fixable, not foundational.**

## 2. The three layers (and why they are SEPARATE)

```
  FORWARD  ─ operations layer ──▶  core: PlexusChange[]  ◀── describing layer ─ BACKWARD
  prospective                      (domain-agnostic       retrospective
  imperative · total · closed      CRDT diff, built)      declarative · lossy · partial
  "addComponent('Card')"                                  "Added component 'Card'"
```

1. **Operations / intents (forward).** The closed, designed, total set of "what one can DO to a
   project" — each op is a deterministic function `operation(typed params) → PlexusChange[]`,
   siteOps/TplMgr-aligned. ~230 ops across 9 areas. This is the *prospective* surface an actor (human,
   or agent via MCP) asks the studio to perform.
2. **The change log (core, built).** The Yjs archive → `PlexusChange[]` lift. Domain-blind: knows
   materialize/set/clear/reparent/detach/insert/remove, point-in-time reads, the cut log, the decorate
   hook. Knows nothing of TplTag/RuleSet/Comment.
3. **The describing layer (backward).** `PlexusChange[] → IntentEvent[]` — the *retrospective*
   recognizer that turns the DB-diff into a human line. **Lossy and partial by design.**

**V's correction — intents ≠ descriptions, kept separate.** The describing layer *uses* the
operations vocabulary as a **recognizer** (it pattern-matches a cluster and says "this looks like
`setArtboardViewMode`"), but does **not depend on it**. Many logged changes have **no operation
behind them** — concurrent-peer CRDT merges, cycle-repair, ownership-rejection cleanup, raw importer
writes, machine stamps. The describing layer must degrade to a generic "edited X" for those and never
fail. The dependency arrow is one-way: describing references operation names as labels; operations
knows nothing of the lens. Collapsing the two would force the lens to fail on un-authored changes and
would grow the op set to cover noise.

## 3. The corrected flagship — the real add-Card

The wave-1 doc's headline "16 changes → 1 event, verified against e2e" is **fabricated** — it matches
neither path (see hardening §1.1):

- The **toy e2e emits 18, not 16** — it includes `TplTag name ∅→'root'` and `locked ∅→false`, because
  `ToyProjectDO.addComponent` passes `{ name:"root", locked:false }` explicitly.
- The **real gesture seeds CSS.** `TplMgr.addComponent` constructs `new TplTag({ tag:"div" })` (no
  name, no locked) then, *in the same transaction*, `root.ensureRuleSet([])` + `display:flex` +
  `flex-direction:column` + `position:relative` (+ `width`/`height:stretch` for page/frame). Those
  reach the lens as `insert` changes on the root RuleSet's `_values` — **not** `∅→default`
  (CSS-initial for `display` is `inline`, not `flex`), so they fall through every drawn MERGE/DROP rule.
- The doc cites the e2e as ground-truth **and** corrects it (the `locked` note), proving the example
  is a third hand-built artifact aligned to neither.

**The grounded re-derivation — model `TplMgr.addComponent`, ~25 low-level changes → 1 event:**

| group | changes | disposition |
|---|---|---|
| `PlainComponent` materialize, anchored by `name ∅→'Card'` | 2 | **EMIT** anchor → `ComponentAdded{name:'Card'}` |
| root `TplTag` materialize + `reparent→Card` + `PlainComponent.tplTree ∅→[root]` + `Site.components insert [uuid]` | ~4 | **MERGE** (structural mirrors of the materialize) |
| root `TplTag tag ∅→'div'` | 1 | **MERGE** (root shell) |
| **root RuleSet `display:flex` · `flex-direction:column` · `position:relative` (+ `width`/`height:stretch`)** | **3–5** | **MERGE — requires a NEW rule (the gap)** |
| `∅→default` / `∅→null` / `∅→""` births (`hiddenFromContentEditor`, `exportTier`, `templateInfo`, `alwaysAutoName`, `trapsFocus`, `locked ∅→null`, `type ∅→null`, …) | ~10 | **DROP** |

The new MERGE rule (hardening §1.1 / §3.1): **birth-time RuleSet value-sets on the anchor's root node**
(owning RuleSet's owner ∈ FRESH) that establish the constructor's default layout shell MERGE into
`ComponentAdded` — they are the layout shell of "added a component", not independent style edits.
Without it, every component-add leaks 3–5 phantom `StylePropertyChanged` lines. Re-baseline the
canonical example off the real path; keep the toy e2e only as a *fixture-shape* example, clearly
labelled "(toy harness — real `TplMgr` path differs)".

## 4. The core-changes spec — the gating critical path

Five **domain-agnostic** widenings of `PlexusChange`. The forward ops are total without them (they
carry keys/indices as typed params); these unblock **backward recognition**. Ordered by leverage:

> **Status (2026-06-24) — the core widenings have LANDED.** C1+C2 (`5cc23e42aa`: Y.Map/record entries lift
> as keyed `set`/`clear`, `PlexusChange.key?` carries the entry key) · C5 (`90a1144463`: reparent/detach
> child-list key `\0`-tuple[1] rides in `field`) · C3 (`3190b54303`: Y.Array reorder detection — same-value
> insert+remove in a cut → one `reorder`). All in `core/src/lift.ts`, with tests (core 24/24, e2e 3/3), fully
> inside `experiments/plexus-history/` (no `foundations/plexus` change). **Deferred to the describing-layer
> build (they need the lens itself):** C4 (deref refs in `before`/`after` — needs the lens + its ref-field
> list) and C2(c) (the entity-keyed-map second resolver). C3's destination index is also deferred (needs
> as-of-cut array reconstruction). The describing-layer re-baseline (§7 step 2) is now unblocked core-side.

| # | widening | what / where | unblocks | effort |
|---|---|---|---|---|
| **C1** | **Pair record/map entries** | `liftFrame` emits a Y.Map value-edit as two *separate keyless* changes (`insert {after}` + `remove {before}`), never paired — so a value edit is indistinguishable from a birth + unrelated remove, and no felt-delta is computable. Pair same-key insert+delete into one `set {key,before,after}` — the map analog of the attr-grouping already done. (`lift.ts:99-113`) | every felt-delta on record-backed fields: RuleSet `_values`, all token `values`, `metadata`, filter params, `flags`, reactions | core, depends on C2 (needs the key first) |
| **C2** | **Surface the entry key** (`key?` / `keyRefs?`) | `resolveContainer` returns `field = owner.parentSub` (the collection name) and discards the inner `item.parentSub` (the actual CSS prop / attr / flag / role / metadata key). **Three stacked shapes:** (a) string key → `key?: string` (~6 lines, easy); (b) **entity-Set** key (variant-scoped `rs` / token `values` — the hover/dark/breakpoint common case) → structured `keyRefs?: EntityRef[]`; (c) **entity** key (`ArgsSet.args` by State, `slots` by SlotParam) → needs a second lens-side resolver pass. Extend `decorate` to walk map keys, not just entity/from/to. (`lift.ts:44-54`) | ~15 humanizations across 6 areas: variant-scoped styling, variant-keyed token values, attrs, props, flags, roles, metadata, comment reactions | core (a/b) + lens (c) |
| **C3** | **A real `reorder` verb** with `{from,to}` indices | `Verb` declares `reorder` but `liftFrame` only emits insert/remove; a Y.Array move = `remove(uuid)+insert(uuid)`, no index → direction unrecoverable, genuine remove-then-readd is a false positive. (`lift.ts:104-113`) | arena/artboard/layer/slot/option/precedence reorders; until it lands, drop `ArenaChanged:reordered` and gate the rest direction-less | core |
| **C4** | **Deref refs in `before`/`after`** (lens-side) | `decorate` labels only `entity`/`from`/`to`. A ref in `after` (TokenAliased target, VariantGroup subject, operation ref, box/textStyle, `Variant.right`, `extends`, `allowedRootChildren`) leaks a raw uuid. Run a `valueAsOf` + displayNameLadder pass over the enumerated ref fields. (`operators.ts:114-120`) | TokenAliased, subjectRebound, chain, box/textStyle clear — all currently assume resolved names | **lens** (archive-read by uuid+seq) |
| **C5** | **Carry `reparent`/`detach` `tuple[1]`** | only `tuple[0]` (parent uuid) is read; the child-list key (`slots`/`arenas`/`children`/`eventHandlers`) is discarded → `WiredEventHandler` cannot recover which event slot, and a generic consumer can't tell which of a parent's child-lists received a child. (`lift.ts:122-141`) | WiredEventHandler event identity; multi-child-list parents | core |

Until all five land, **every record-backed felt-delta template must be demoted to an explicit degrade**
("Card: styling changed (N properties)") and the §3 "never a DB diff" law cannot be asserted for
record-backed fields. C1+C2 are the tightest knot (C1 needs C2). C4 is the only pure-lens item.

## 5. The numbers, corrected

- **Operations vocabulary: ~230 forward ops** across 9 areas (32 + 19 + 22 + 16 + 22 + 29 + 12 + 20 + 58).
- **Reconciliation: ~55 ALIGNED · ~12 SUPERSET · ~110–130 NEW** — **not the wave-2 figure of ~165.**
  The survey **undercounted the studio surface** (tallied only TplMgr+SiteOps ≈71; real surface is
  ~120–150 once VariantOps, insertion-ops, `providers/core/operations/`, and `studioCtx`-direct
  methods like `changePagePath` / `addNewMixedArenaFrame` are counted) and therefore **over-counted
  NEW by ~20–30%.** ~25–40 "NEW" ops actually have a coarse studio home the survey missed
  ("ALIGNED-but-coarse"). The MCP side (~82 actions / 13 clusters) was counted accurately.
- **The reveal survives** at the corrected magnitude: Operations, Imports, Project-Variables, and the
  type-shape/slot cluster genuinely lack any named method, and the MCP/agent surface cannot create a
  component, add a reactive handler, or author an Operation/Import/Split today. That is a real
  consolidation opportunity — just ~110–130, not 165.

## 6. The decisions for V (decide before build)

**The big architectural one — convergence (operations-layer §3):** three forward surfaces aim at the
same semantic space (siteOps/TplMgr studio gestures · MCP `projectEditingTool` agent verbs · this
derived vocabulary). Pick:

- **A — One unified intent layer, MCP-as-realization.** Treat the vocabulary as spec; grow the MCP
  clusters to total coverage; make siteOps a thin caller of the same named ops. *Cost:* large (~110–130
  new verbs, decompose `updateState` + `buildInteractionAction`, build the slot cluster). *Win:* agent↔studio
  parity through ONE vocabulary; lens recognizers map 1:1; the actor-corollary finally met.
- **B — Two surfaces, shared op-core.** Keep siteOps and MCP as distinct front-doors, but extract the
  named ops as a shared library both call (siteOps stops direct writes; MCP stops edge tuple-collapse).
  *Cost:* medium. *Win:* every mutation becomes a named op → reliable lens recognizer, without forcing
  either surface's shape onto the other.
- **C — Leave forward as-is, vocabulary is spec-only.** The ops are a reference catalog the lens uses
  as a recognizer; surfaces stay split/partial. *Cost:* ~zero. *Win:* none beyond documentation.

Plus the cross-cutting sub-decision (independent of A/B/C): does MCP keep its deliberate **coarse**
call-shape (tuple-replace-whole-handler, flat params — per the call-shape research that flat is
LLM-better) or adopt model-fine granularity? Embedded recommendation: build narrow/coarse first, add
fine ops only on concrete agent need.

**The product judgment calls (one consolidated list):**

1. **`ProjectCreated`/`ProjectRenamed`** — out-of-model (resolved from API/DB via injected resolver,
   like the comment author) or t0-snapshot only? They back onto `ProjectPackage.name`, which the lift
   skips and which has no synced writer — they cannot derive from `PlexusChange[]`.
2. **Burst / coalescing threshold** — debounced typing and drag-resize span many cuts; needs a
   `groupBy("burst")` policy ("≥N same-kind value-changes in a window → summarize"). Threshold unset.
3. **Salience allowlist** — `ComponentBase.metadata` (raw Record) and importer/`cacheNpmPackageTypes`
   stamps will flood the human log. Move from "EMIT-all" to a lens-owned DROP allowlist of machine-stamp
   key prefixes. Which prefixes?
4. **Data-flow invalidation owner** — `invalidateAll:true` ("refresh all queries") has no EMIT home as
   drawn; the target is reachable from 3 parents. Data area or Behavior area owns it?
5. **`Site.userManagedFonts`** (web-font family Set) — first-class "Added web font {family}" intent
   (the value IS the label, no key-loss) or a separate settings area? Currently DROP — hardening argues
   it silently erases a real gesture (Google-font picker, Figma import).
6. **`represents` tag on arg-shape nodes** — a no-codegen-effect curator annotation; EMIT terse or DROP
   entirely? Weakest EMIT in the set.
7. **Multi-line gestures: collapse or keep?** — reparent+rename in one cut emits `NodeMoved` +
   `NodeRenamed`; a variant-add sets `standalone` + condition together. One event or two?
8. **The DSD ↔ ValueOperation duplication** — two parallel callable systems with near-identical shapes
   (the only intentional non-orthogonality in the op set: `addDataSource ≈ addOperation`). Resolve the
   migration, or keep both as one allowed overlap?
9. **`VariantsCombination` ownership** — its parent is `ArgsSet` (node activation), not a variants
   entity; provisionally DROPped in the Variants area to avoid a latent double-count. Confirm the
   render-tree/node-activation area owns it.
10. **Intra-arena frame reorder** — DROP (canvas position is top/left, not list index)? Confirm
    intentional.

## 7. Recommended path

Build order — **core fixes first, then describing, then operations** — because the describing layer is
the gated one and the operations layer is where the convergence decision (A/B/C) lands the most code:

1. **Core widenings C1–C5** (§4). The critical path. C2 then C1 (C1 needs the key); C3, C4 (lens),
   C5 in parallel. *Gated by:* nothing — these are mechanical, decision-free.
2. **Re-baseline the flagship + describing layer** off the real `TplMgr` path (§3), add the
   RuleSet-shell MERGE rule, the FRESH-by-ancestry generalization, the ~35 newly-covered rows, the
   field→subKind tables, and the ~15 humanization rewrites (four are missing-helper catalog rows, not
   degrades). *Gated by:* C1–C5 (felt-deltas stay degraded until they land) + product decisions **1, 2, 3**
   (project-genesis, burst, salience) — these shape what the lens emits.
3. **Operations layer.** *Gated by:* the convergence decision (**A/B/C**) — it determines whether this
   is new MCP clusters (A), a shared op-core refactor (B), or spec-only (C) — plus decisions **4–10**,
   which fix specific op boundaries (invalidation owner, font intent, DSD↔Operation, combination
   ownership, reorder).

To restate plainly: **this run was design-only.** The build and every decision above are V's. The docs
are the map; the route through it is yours to pick.
