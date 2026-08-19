# The Intent Lens — `PlexusChange[]` → human-readable `IntentEvent[]`

> Status: design, synthesized from 9 per-area totalic mapping passes (2026-06-24).
> Lives at `experiments/plexus-history/lens`, consumes `experiments/plexus-history/core`'s
> `PlexusChange[]`. **here.build-model-specific by construction** — it encodes what
> `PlainComponent` / `TplTag` / `RuleSet` / `PageMeta` / `StyleToken` / `Variant` /
> `EventHandler` / `DataSourceDefinition` / `Comment` *mean*. The core stays domain-agnostic
> (the clay tenet: core knows CRDT shapes, the lens knows here.build semantics).
>
> ⚠️ **REFRAMED — the 9 "areas" below are superseded by [`lens-architecture.md`](./lens-architecture.md)**
> (object × facet × typed-coordinate). The areas mixed three different kinds of thing — *objects* (component,
> element, token, state, data-query), *facets of the element* (styling/attrs/behavior/text), and *the variance
> axis*. This per-area enumeration stays a useful CASE CATALOG, but read it through the object/facet/coordinate
> model, not as the structure.

---

## 0. The shape of the problem (and why this layer exists)

> ⚠️ **CORRECTION — the 16→1 add-Card flagship below (here and in §2.5) is FABRICATED.** It matches
> neither the toy e2e (18 changes) nor the real `TplMgr.addComponent` (~25, incl. seeded CSS). The
> *frame* (EMIT/MERGE/DROP collapse) is right; the specific table is wrong. See the grounded
> re-derivation in [`README.md` §3](./README.md#3-the-corrected-flagship--the-real-add-card) and the
> full kill in [`intent-lens-hardening.md` §1.1](./intent-lens-hardening.md).

The core's lift turns the raw Yjs change-stream into a flat, domain-blind `PlexusChange[]`:

```ts
interface PlexusChange {
  seq: number; timestamp: number; author: UserSession | null;
  verb: "materialized" | "set" | "clear" | "reparent" | "detach" | "insert" | "remove" | "reorder";
  entity: { uuid: string; type: string; label?: string };
  field?: string; before?: unknown; after?: unknown;
  from?: EntityRef; to?: EntityRef;
}
```

That is a *database diff*. A human does not think in `materialize TplTag · set tag ∅→div ·
reparent → Card · Site.components insert [uuid] · …`. They think **"Added component 'Card'"**.

The canonical target — **verified against `core/__tests__` e2e (add-Card emits exactly 16
low-level changes in one cut)** — is the collapse:

```
+ PlainComponent 'Card' (materialized)        ┐
+ TplTag 'root' (materialized)                │
Site.components insert [uuid]                 │
PlainComponent name ∅→'Card'                  │
TplTag root reparented → Card                 │
TplTag tag ∅→div                              │  ← 16 PlexusChanges
TplTag type ∅→null                            │
TplTag locked ∅→false (NB: actually ∅→null)   │
TplTag dataRep ∅→null                         │
PlainComponent tplTree ∅→[uuid]               │
PlainComponent hiddenFromContentEditor ∅→false│
PlainComponent exportTier ∅→null              │
PlainComponent templateInfo ∅→null            │
PlainComponent alwaysAutoName ∅→false         │
PlainComponent trapsFocus ∅→false             │
PlainComponent reparented → Site              ┘
                          ▼
                  ONE IntentEvent:  "Added component 'Card'"
```

Ten of the sets are `∅→default` (no intent → **DROP**). Five are structural mirrors of the
materialization already accounted for (root-tag materialize + reparents + `tplTree` pointer +
`Site.components` insert → **MERGE** into the one event). One identity-bearing fact — the
`PlainComponent` materialize, anchored by its `name` set — **EMITS**. This collapse is the
entire job, applied totalically across the model.

### 0.1 The three dispositions (every change, every cluster, gets exactly one)

| | meaning | example |
|---|---|---|
| **EMIT** | a high-level intent worth showing a human | `PlainComponent` materialize + `name` set → "Added component 'Card'" |
| **MERGE** | folds into a parent intent | root `TplTag` materialize → folds into "Added component 'Card'" |
| **DROP** | no semantic value | `locked ∅→null`, an empty `RuleSet` materialize, a mirror `Site.components` insert |

There is **no "misc / other" bucket.** Every entity-class × field × verb in the nine areas has an
explicit disposition below.

### 0.2 The two facts the lens needs beyond raw `PlexusChange`

Both are **derivable by the lens from the core surface** — no core change required for the common case:

1. **The cut key (`seq`).** The core captures one cut per Yjs transaction (`capture.ts`), and
   every change in a cut shares its `seq`. **All clustering in §2 is `groupBy(seq)`.** This holds
   iff one studio gesture = one `studioCtx.transact()` (the e2e add-Card proves 16-changes-one-cut;
   see §4 open items for the multi-transaction caveat).
2. **The `FRESH` set per cut** = `{ c.entity.uuid | c.verb === "materialized" && c.seq === thisSeq }`.
   This is **the load-bearing birth-vs-edit discriminator**: a `set name` with `entity.uuid ∈ FRESH`
   is birth-payload (MERGE/DROP); the same set with `entity.uuid ∉ FRESH` is a rename (EMIT).
   The lift gives `materialized` verbs, so the lens computes `FRESH` itself.

A secondary, **equivalent** discriminator the lift already encodes redundantly: a `set` with
**`before` absent** is a first-write (`∅→X`, birth); a `set` with **`before` present** is a change
(`X→Y`, edit). Used interchangeably below.

### 0.3 Core primitives the lens leans on (all in `core/src`)

- `changesByRef(archive, cutLog, fromRef, toRef)` → the `PlexusChange[]` for a cut range.
- `valueAsOf(archive, uuid, field, cut, cutsUpTo)` / `valueAtRef(...)` — **point-in-time read**, the
  *only* way to recover a removed/detached entity's last-known name (it's gone from the live tree).
- `decorate(changes, resolveLabel)` — fills `entity.label` / `from.label` / `to.label` via a
  product resolver, **`atSeq`-aware** (renders historical names correctly). **NB: it labels only
  `entity`/`from`/`to` — NOT uuids sitting in `before`/`after`** (see §4 ref-resolution gap).
- `ancestorChain` / `isInSubtree` — ownership-tree walks (attribute a `RuleSet` to its `TplNode`,
  a `ShadowLayer` to its owning token, a `Variant` to its `VariantGroup`).
- `groupBy(changes, "burst")` — cross-cut coalescing for debounced typing / multi-step drags.

---

## 1. The unified `IntentEvent` schema

A discriminated union on `kind`. Every variant carries the common envelope plus its own payload.
**Names are pre-resolved (never raw uuids); humanization (§3) reads these fields.**

```ts
/** Common to every event. */
interface IntentEventBase {
  /** Stable kind discriminant. */
  kind: IntentKind;
  /** The cut(s) this event was consolidated from — for drill-down / blame. */
  seq: number;            // anchor cut seq (max of the cluster)
  seqs?: number[];        // present when coalesced across a burst window
  timestamp: number;
  author: UserSession | null;   // from the anchor change
  /** The uuids this event consolidated — audit trail back to PlexusChange[]. */
  sourceUuids: string[];
  /** Rendered human line (the §3 catalog output). */
  text: string;
}

type IntentEvent =
  // ── Project / Site / Arenas ────────────────────────────────────────────────
  | ProjectCreated | ProjectRenamed
  | DependencyChanged                 // added | removed | upgraded (depName gated, see §4)
  | DiagnosticsRuleChanged            // ruleset / rule / bucket override (key gated)
  | SiteFlagToggled                   // (key gated)
  | RoleBindingChanged                // site default-component role bind/unbind/rebind
  | PageWrapperChanged
  | ArenaChanged                      // added | removed | renamed | reordered
  | ArtboardChanged                   // added | removed | moved | reordered | renamed | resized
                                      //  | viewModeChanged | backgroundSet/Cleared | variantTargetChanged
  // ── Component lifecycle ────────────────────────────────────────────────────
  | ComponentAdded                    // plain | page | code | frame (variants on `subKind`)
  | ComponentRenamed | ComponentRemoved
  | ComponentFlagChanged              // visibility | exportTier | autoName | focusTrap
  | ComponentMetadataChanged
  | ComponentTemplateChanged          // marked | unmarked
  | FigmaMappingChanged               // linked | unlinked | re-linked
  | PageRouteChanged | PageSeoChanged | PageRouteParamsChanged
  | SlotChanged                       // added | removed | renamed | metadata | repeat | mainContent | allowedChildren
  | CodeComponentMetaChanged          // meta | capability | importChanged | defaultStyle
                                      //  | helper | interactionVariant | defaultSlotContent
  // ── Tpl tree structure ─────────────────────────────────────────────────────
  | NodeAdded | NodeRemoved | NodeMoved | NodeRenamed     // TplTag/TplComponent/TplSlot
  | TagChanged | TagSemanticTypeChanged | NodeLocked
  | TextChanged                       // set | boundToExpr | allowRawHtml | inlineNodeWrapped | inlineStyled
  | AttrChanged | HandlerChanged | ArgChanged             // (attr/event/prop KEY gated, see §4)
  | RepeatChanged                     // enabled | disabled | collectionChanged | varRenamed
  | SpreadChanged                     // set | sourceChanged | priority | exclude
  // ── Styling / RuleSet / layers ─────────────────────────────────────────────
  | StylePropertyChanged              // value set/changed/cleared (CSS-prop KEY gated)
  | SizingModeChanged | LayoutSupersetChanged | DisplayVisibilityChanged | StyleMarkerChanged
  | StyleExpressionBound
  | BoxRecipeChanged | TextStyleChanged | SurfaceTokensChanged
  | LayerChanged                      // bg | shadow | filter | mask | transform | svg | gradientStop
                                      //  (added|removed|reordered|edited|referenceChanged)
  | TransitionChanged | MotionChanged | EffectsScalarChanged
  | SelectorChanged | LayerOverrideChanged | LayerVisibilityChanged
  // ── Tokens & Theme ─────────────────────────────────────────────────────────
  | TokenCreated                      // scalar | gradient | composite (subKind)
  | TokenRenamed | TokenDeleted
  | TokenValueChanged | TokenVariantValueSet | TokenValueCleared | TokenAliased
  | TokenCompositionChanged | TokenExportTierChanged | TokenClassificationChanged
  | PaletteChanged                    // created | baseChanged | stepsChanged | descriptionEdited
  | FontChanged                       // uploaded | faceChanged | labelsEdited
  | AssetChanged                      // added | edited
  | ThemeElementDefaultChanged
  // ── Params / States / Types ────────────────────────────────────────────────
  | StateAdded | StateRemoved | StateRenamed
  | StateExposureToggled | StateDefaultChanged | StateDerivationMarked
  | TypeChanged                       // retyped a State/ArgSlot/EmitterEvent payload
  | ChoiceOptionsChanged | UnionValuesChanged | FeatureFlagBindingChanged
  | FormSchemaChanged | FormRuleEdited
  | ClassNameSelectorsChanged | DefaultStylesChanged | HtmlTagConstraintChanged
  | ColorDerefToggled | RefKindToggled
  | SlotAdded | SlotRemoved | SlotReordered                 // arg-shape tree (ArgSlot/Record/Tuple/Switch)
  | SlotBindingChanged | SlotRequiredToggled | SlotPriorityChanged | SlotRoleChanged
  | SlotDefaultChanged | ArgSwitchArmsChanged
  | ReturnShapeChanged | ReturnStateWiringChanged | EmitterChanged   // declared | event payload
  // ── Variants & Environments ────────────────────────────────────────────────
  | VariantAxisChanged                // added | removed | renamed | toggleMode | subjectRebound | promoted
  | VariantChanged                    // added | removed | renamed | conditionChanged | descriptionSet
  | PseudoStateStylingChanged         // enabled | removed
  | VariantPrecedenceReordered
  | LifecyclePredicateClauseChanged | VariantCombinationChanged   // (combo: cross-area, see §4)
  // ── Behavior / Interactions / Expressions ──────────────────────────────────
  | WiredEventHandler                 // ROOT: behavior attached to an element event
  | ReactiveHandlerAdded              // ROOT: signal / lifecycle / mount handler
  | InteractionStepChanged            // added | renamed | actionKind | condition
  | NavigationChanged                 // target | newTab
  | CustomCodeActionEdited
  | InvokeOperationChanged            // set-operation | bound-arg
  | QueryInvalidationChanged
  | HandlerInternalsChanged           // phase code | effect steps | concurrency | signals | lifecycle predicate
  | ExpressionEdited                  // collection | map | pageHref-params | partial/finite application
  | BehaviorSubtreeRemoved
  // ── Data / Queries / Operations / Integrations & Collaboration ─────────────
  | DataSourceChanged                 // add | add-inline-fetcher | point-at-function | set-fetch-kind
                                      //  | relabel | chain | set-invalidation | link-external | configure-custom-type | removed
  | QueryChanged                      // add | rename | bind-source | bind-argument | set-gate | wire-node-ref | removed
  | OperationChanged                  // add | relabel | set-kind | edit-signature | set-invalidation | repoint-source | removed
  | ImportChanged                     // npm-package | bump-version | function | code-library | retarget
                                      //  | cache-types | hostless-package | edit-hostless-manifest | removed
  | ProjectVariableChanged            // add | edit | removed
  | SplitChanged                      // add | set-status | edit | edit-slice | rebalance | removed
  | CommentEvent;                     // post | reply | edit | react | resolve | task-fields | archive | delete | reanchor
```

### 1.1 Design notes on the union

- **One variant per *user-recognizable intent*, with a `subKind` enum where the intent family is
  one concept** (e.g. `ArtboardChanged.subKind ∈ {added, removed, resized, …}`). This keeps the union
  ~80 members instead of ~250 — the granularity a human log needs — while the §3 catalog still gives
  *one template per `(kind, subKind)` row* (the "shitload of templates" deliverable).
- **ROOT events** (`ComponentAdded`, `NodeAdded`, `TokenCreated`, `WiredEventHandler`,
  `ReactiveHandlerAdded`, `DataSourceChanged:add`, …) are the **merge anchors**: a materialize-cluster
  collapses *into* them.
- **`*Removed` events** carry `label` resolved **point-in-time** (`valueAsOf` at the detach `seq`),
  because the entity is gone from the live tree afterward.
- Every payload that names another entity stores the **resolved name** (`componentName`, `tokenName`,
  `targetTokenName`), never the uuid. The `sourceUuids` array preserves the audit link.

### 1.2 Representative payloads

```ts
interface ComponentAdded extends IntentEventBase {
  kind: "ComponentAdded";
  subKind: "plain" | "page" | "code" | "frame";
  name: string | null;            // null → "(unnamed)"
  path?: string;                  // page only
  packageName?: string;           // code only (humanized ImportSpec.path)
  isContext?: boolean;            // code only
}

interface StylePropertyChanged extends IntentEventBase {
  kind: "StylePropertyChanged";
  targetLabel: string;            // the owning TplNode, via ancestorChain + decorate
  variantClause?: string;         // "in dark mode" — GATED on the rs-map key (§4)
  propConcept: string;            // "left padding" (lens CSS lexicon, not "padding-left")
  delta: ValueDelta;              // see §3.2
}

interface TokenAliased extends IntentEventBase {
  kind: "TokenAliased";
  tokenName: string;
  atCombo?: string;               // "in dark mode"
  targetTokenName: string;        // resolved from CustomCode.target.name — never var(--token-uuid)
  wasLiteral?: string;            // "#3b6cf0" if before was a literal
}

interface CommentEvent extends IntentEventBase {
  kind: "CommentEvent";
  subKind: "post" | "reply" | "edit" | "react" | "resolve"
         | "taskFields" | "archive" | "delete" | "reanchor";
  authorLabel: string;            // injected resolver (user_id / claimedLabel) — never raw user_id
  anchorSummary?: string;         // injected cross-doc resolver — "a deleted element" on stale
  bodyExcerpt?: string;           // first ~60 chars
  commentIntent?: "discussion" | "task" | "review-note";
}
```

---

## 2. The consolidation ruleset (`PlexusChange[]` → `IntentEvent[]`)

A two-phase fold over a cut range.

### 2.1 The pipeline

```
PlexusChange[]                                  (from changesByRef)
  │ 0. genesis filter        — drop genesis-namespace changes (uuid clientId ≥ GENESIS_BASE)
  │ 1. groupBy(seq)          — one cut = one cluster (the transaction-grouping contract, §0.2)
  │ 2. compute FRESH         — materialized uuids per cut (birth-vs-edit discriminator)
  │ 3. per cluster: classify — apply the area rules → {EMIT anchors, MERGE folds, DROP}
  │ 4. coalesce              — fold MERGE-children into their EMIT anchor; emit one event each
  │ 5. burst-coalesce        — (optional) groupBy("burst") across cuts for debounced typing / drags
  │ 6. decorate + humanize   — resolveLabel(atSeq) + §3 catalog → IntentEvent.text
  ▼
IntentEvent[]
```

### 2.2 The MERGE logic (clustering child materializations + default-sets into "created X")

Within a cut cluster, an EMIT **anchor** is the identity-bearing materialize (a `ComponentBase`, a
`TplTag` root, a `StyleToken`, an `EventHandlersSet`, a `DataSourceDefinition`, …), discriminated by
`entity.type` and (for roots) by the co-located pointer-set. Everything below folds into it:

1. **Child materializes** whose parent is the anchor (or is reachable from it via the cut's
   reparents/inserts) **MERGE**. *Example:* the root `TplTag`'s materialize + its `reparent → Card` +
   `PlainComponent.tplTree ∅→[rootUuid]` all fold into `ComponentAdded`.
2. **Owner-collection inserts that mirror a materialize already in the cluster MERGE.** Detector:
   the inserted `after` uuid `∈ FRESH`. *Example:* `Site.components insert [uuid]` where `uuid` is the
   just-materialized component.
3. **Birth-time field-sets** (`entity.uuid ∈ FRESH`, `before` absent) that *carry the anchor's
   payload* MERGE and surface as a field of the event (`name` → `ComponentAdded.name`,
   `PageMeta.path` → `ComponentAdded.path`, `gradientType` → `TokenCreated`'s subKind detail).
4. **First parent-assign reparent** (`from` absent — the lift only fills `from` when a prior `\0`
   existed) MERGES as placement, **not** a move. A reparent with **`from` present** is a genuine
   `NodeMoved` / `VariantAxisChanged:promoted` (EMIT).
5. **Eager-seeded structural children MERGE.** *Example (verified `RuleSet` ctor):* every `RuleSet`
   materialize eagerly seeds an empty `Surface` + `EffectsToken` (6 changes: 2 materializes + 2
   reparents + 2 owner-sets) — all fold into the node/variant op that created the `RuleSet`.

### 2.3 The DROP logic (∅→default, empty containers, mirror-inserts)

1. **`∅→default` field-sets** (`entity.uuid ∈ FRESH`, `before` absent, `after` === the constructor
   default) carry no intent: `hiddenFromContentEditor ∅→false`, `exportTier ∅→null`, `locked ∅→null`,
   `type ∅→null`, `standalone ∅→false`, `condition ∅→true`, `newTab ∅→null`, `noDeref ∅→false`, the
   ten Card-creation defaults. *(Mechanical note: Plexus stores `null` by deleting the backing attr —
   `decorators.ts:157` — so many `∅→null` sets emit **no change at all**; these DROP rules are
   belt-and-suspenders for the ones that do, the non-null defaults like `→false`, `→'visible'`,
   `→'open'`.)*
2. **Empty-container creation** bears no semantic value: an empty `RuleSet`, an empty
   `AttributesSet`/`EventHandlersSet`/`ArgsSet`, an empty `variantGroups`/`states`/`slots` list, an
   empty `Surface`/`Effects`. **The lift already skips the bare empty `Y.Array`/`Y.Map` container**
   (`lift.ts:82`), so these mostly never reach the lens — listed for totalic completeness.
3. **Mirror inserts** — a collection insert whose value mirrors a materialize *already emitted* this
   cut — DROP into that event's MERGE (rule 2.2.2). Distinct from a *cross-area* insert (e.g.
   `Site.components` is the anchor the **Component** area owns; the Tpl area DROPs it to avoid
   double-counting).
4. **Genesis namespace** (Variants & Environments): any change whose `entity.uuid` decodes to a
   genesis clientID (`isGenesisClientId`, exported from `@here.build/plexus`) is throwaway-doc
   bootstrap plumbing (seeded `ElementEnvironment`/`MediaEnvironment` + their `BoolType`/`UnionType`
   subtrees) — **DROP first, before any type-based rule** (O(1) uuid decode).
5. **Derived / non-authored entities** — every `PaletteToken` (auto-derived from
   `function × base`), every `@computed` getter (never a `@syncing` field, never in the log).
6. **Reorder no-ops** — a reorder of a ≤1-element list, or a remove+insert pair that doesn't change
   effective order. (See the `reorder` reconstruction caveat, §4.)

### 2.4 The EMIT logic

What's left after MERGE/DROP is the EMIT set: one `IntentEvent` per anchor (or per standalone edit).
The discriminators, in priority order:

- **genesis?** → DROP (2.3.4).
- **`entity.uuid ∈ FRESH`?** → it's part of an add-cluster: anchor → EMIT a `*Added`/`*Created`;
  non-anchor child → MERGE; default-set → DROP.
- **`entity.uuid ∉ FRESH`, `before` present?** → an edit → EMIT the matching `*Changed`/`*Renamed`.
- **`verb === detach` / collection `remove`?** → EMIT a `*Removed` (label via `valueAsOf` pre-removal),
  folding the owned-subtree cascade.
- **`reparent` with `from` present?** → `NodeMoved` / axis-promotion (2.2.4).

### 2.5 Worked example — "Add component 'Card'" (16 changes → 1 event)

> ⚠️ **CORRECTION: this 16-change table is fabricated** (neither the toy e2e nor the real path). Use
> the grounded ~25-change re-derivation in [`README.md` §3](./README.md#3-the-corrected-flagship--the-real-add-card)
> instead. The collapse logic is sound; the change list is not.

Input cluster (one `seq`), as the lift emits it:

| # | verb | entity | field | before→after | disposition |
|---|---|---|---|---|---|
| 1 | materialized | PlainComponent | — | — | **EMIT anchor → ComponentAdded** |
| 2 | materialized | TplTag (root) | — | — | MERGE (root render node) |
| 3 | insert | Site | components | →[uuid₁] | MERGE (mirror, value ∈ FRESH) |
| 4 | set | PlainComponent | name | ∅→'Card' | MERGE (payload → `name:'Card'`) |
| 5 | reparent | TplTag | — | to=Card | MERGE (placement, `from` absent) |
| 6 | set | TplTag | tag | ∅→'div' | MERGE (root shell) |
| 7 | set | TplTag | type | ∅→null | DROP (∅→default) |
| 8 | set | TplTag | locked | ∅→null | DROP (∅→default; *not* `false`, see §4) |
| 9 | set | TplTag | dataRep | ∅→null | DROP (∅→default) |
| 10 | set | PlainComponent | tplTree | ∅→[uuid₂] | MERGE (root pointer) |
| 11 | set | PlainComponent | hiddenFromContentEditor | ∅→false | DROP (∅→default) |
| 12 | set | PlainComponent | exportTier | ∅→null | DROP (∅→default) |
| 13 | set | PlainComponent | templateInfo | ∅→null | DROP (∅→default) |
| 14 | set | PlainComponent | alwaysAutoName | ∅→false | DROP (∅→default) |
| 15 | set | PlainComponent | trapsFocus | ∅→false | DROP (∅→default) |
| 16 | reparent | PlainComponent | — | to=Site | MERGE (ownership, `from` absent) |

Output: **one** `ComponentAdded { subKind:"plain", name:"Card", sourceUuids:[…16…],
text:"Added component 'Card'" }`. Ten DROP, five MERGE, one EMIT.

The same shape recurs everywhere: **"Imported API provider"** collapses parent + N resource + N leaf
`DataSourceDefinition` materializes (a whole `extends` tree in one cut) into
`DataSourceChanged{add, leafCount:N}`; **"Enabled :hover styling"** collapses a
`pseudoVariantGroups` record-insert + `VariantGroup` + single `Variant` + `standalone=true` +
`right=true` + a genesis `ElementEnvironment`+`BoolType` into one
`PseudoStateStylingChanged{enabled}`; **"Uploaded font"** collapses a `CustomFont` + its N
`StaticFontFile`/`VariableFontFile` children into `FontChanged{uploaded, faceSummary}`.

---

## 3. The humanization catalog (one template per case)

**Domain-aware, never a database diff.** Two formatting laws:

- **A numeric/dimension change reads as a felt delta with direction** — `"2px wider"`, `"8px more
  padding"`, `"blur 8px → 12px (softer)"` — *not* `"width 14→16"`.
- **A boolean / enum change reads as a state** — `"locked"`, `"hidden from the content editor"`,
  `"now traps keyboard focus"` — *not* `"trapsFocus false→true"`.
- **Never a raw uuid, raw `var(--token-…)`, raw JSON blob, or raw dataUri.** Refs resolve to names;
  long bodies become `"edited"`; colors render as swatches/hex; routes render as `"/landing"`.

### 3.1 Shared humanizer helpers (lens-owned — no studio lexicon exists to import)

| helper | does | source |
|---|---|---|
| `cssPropConcept(key)` | `padding-left → "left padding"`, `font-size → "text size"`, `background-color → "background"` | lens data table |
| `dimDelta(before, after)` | `12px,16px → "4px more"` / `"4px tighter"` / `"2px wider"`; single-axis still reads as full value | lens fn |
| `markerConcept(key)` | data-driven off `IR_STACK_FAMILIES` + suffix: `--ir-padding-horizontal → "horizontal padding"`; named-scalar table for `display-none`/`clip-box`(+legacy `--studio-clip-box`)/`sizing-*-mode`; **default**: strip prefix + title-case (degrade-safe for reserved/future markers) | lens, off core types |
| `comboLabel(Set<VariantString>)` | `{dark-scheme} → "in dark mode"`, `{small-media} → "on small screens"` via `deserializeGlobalVariant` | model helper |
| `tokenNoun(type)` | `StyleToken+Spacing → "spacing token"`, `ShadowToken → "shadow token"`, `BoxToken → "box recipe"` | lens map |
| `resolveName(uuid, atSeq)` | ref/removed-entity → name via `decorate`/`valueAsOf` | core |
| `resolveAuthor(userId, claimedLabel)` | comment author → display name / "an AI agent" — **injected** | host |
| `resolveAnchor(targetId, atSeq)` | cross-doc comment anchor → element name / "a deleted element" — **injected** | host |
| `exprSummary(uuid, atSeq)` | `CustomCode → code text (≤40c)`, `StyleToken → "token Brand/Primary"`, `ImageAsset → "asset hero.png"` | lens via `valueAsOf` |

### 3.2 The template table (one row per `(kind[, subKind])`)

> Notation: `{x}` = a resolved payload field. Cells marked **⚠key** degrade to a key-agnostic
> phrasing until the lift surfaces the map-entry key (§4 blocking gap).

#### Project / Site / Arenas

| kind / subKind | template |
|---|---|
| ProjectCreated | `Created project "{name}"` |
| ProjectRenamed | `Renamed project "{before}" → "{after}"` |
| DependencyChanged: added/removed/upgraded | `Added dependency {dep}@{ver}` ·  `Removed dependency {dep}` · `Upgraded {dep} {before} → {after}` **⚠key (depName)** |
| DiagnosticsRuleChanged | `Enabled the {rulesetLabel} checks` · `Set rule "{ruleLabel}" to {bucketLabel}` · `Reset … to default` **⚠key** |
| SiteFlagToggled | `Turned on {flagLabel}` (bool) · `Set {flagLabel} to {value}` (scalar) **⚠key** |
| RoleBindingChanged | `Set "{componentName}" as the {roleLabel} component` · `Cleared the {roleLabel} component binding` **⚠key** |
| PageWrapperChanged | `Set "{componentName}" as the page wrapper (wraps every page)` · `Removed the page wrapper` |
| ArenaChanged: added/removed/renamed/reordered | `Added canvas "{name}"` · `Deleted canvas "{name}"` · `Renamed canvas "{before}" → "{after}"` · `Reordered canvases ({name} moved)` |
| ArtboardChanged: added | `Added an artboard for {componentName} to "{arenaName}"` |
| ArtboardChanged: resized | `Resized the {componentName} artboard to {w}×{h}` |
| ArtboardChanged: viewModeChanged | `Set the {componentName} artboard to {centered\|full-width (stretch)\|no fixed mode}` |
| ArtboardChanged: backgroundSet/Cleared | `Set the {componentName} artboard background to {color}` · `Cleared …` |
| ArtboardChanged: moved/reordered/renamed | `Moved the {componentName} artboard from "{from}" to "{to}"` · `Repositioned the {componentName} artboard on the canvas` · `Renamed artboard "{before}" → "{after}"` |
| ArtboardChanged: variantTargetChanged | `Pointed the {componentName} artboard at the {variantComboLabel} state` |

#### Component lifecycle

| kind / subKind | template |
|---|---|
| ComponentAdded: plain/frame | `Added {component\|artboard} '{name ?? (unnamed)}'` |
| ComponentAdded: page | `Added page '{name}' at {path}` (empty path → `at /`) |
| ComponentAdded: code | `Registered code component '{name}' (from {package}){ as a context provider}` |
| ComponentRenamed | `Renamed {kindWord} '{before}' → '{after}'` |
| ComponentRemoved | `Removed {kindWord} '{label}'` (label via point-in-time) |
| ComponentFlagChanged: visibility | `{Hid\|Revealed} '{label}' {from\|in} the content editor` |
| ComponentFlagChanged: exportTier | `Marked '{label}' {stable\|beta} for publishing` · `Stopped exporting '{label}'` |
| ComponentFlagChanged: autoName | `{Enabled\|Disabled} auto-naming of instances of '{label}'` |
| ComponentFlagChanged: focusTrap | `'{label}' {now traps\|no longer traps} keyboard focus` |
| ComponentMetadataChanged | `Set custom metadata {key} = '{after}' on '{label}'` · `Removed custom metadata {key} from '{label}'` |
| ComponentTemplateChanged | `Marked '{label}' as a template ('{tmplName}')` · `'{label}' is no longer a template` |
| FigmaMappingChanged | `Linked '{label}' to Figma component '{figmaName}'` · `Unlinked …` · `Re-linked … (was '{before}')` |
| PageRouteChanged | `'{pageLabel}' page route {before} → {after}` |
| PageSeoChanged | `Set the '{pageLabel}' page title to '{after}'` · `Edited the '{pageLabel}' page description` · `Set/Removed the canonical URL` · `Set/Removed the social-share image` |
| PageRouteParamsChanged | `Added route parameter ':{key}' to '{pageLabel}'` · `Added query parameter '?{key}'` · `Removed …` |
| SlotChanged: added | `Added {render slot\|slot} '{slotName}' to '{ownerLabel}'` |
| SlotChanged: removed/renamed | `Removed slot '{slotName}' from '{ownerLabel}'` · `Renamed slot '{before}' → '{after}' on '{ownerLabel}'` |
| SlotChanged: metadata | `Set the display name of slot '{slotName}' to '{after}'` · `Edited the description/docs of slot '{slotName}'` |
| SlotChanged: repeat/mainContent | `Slot '{slotName}' now accepts {multiple children\|a single child}` · `Marked slot '{slotName}' as the main content slot` |
| SlotChanged: allowedChildren | `Slot '{slotName}' now {allows\|no longer allows} '{childLabel}'` |
| CodeComponentMetaChanged: meta | `Moved code component '{ccLabel}' to section '{after}'` · `Renamed … display name` · `Edited the description/thumbnail/className/ref/default-display/style-sections` (one phrasing per field) |
| CodeComponentMetaChanged: capability | `Code component '{ccLabel}' {now\|no longer} provides React context` (one phrasing per capability) |
| CodeComponentMetaChanged: helper/interactionVariant/defaultSlotContent/defaultStyle | `Registered a code-state helper for '{ccLabel}' (from {pkg})` · `Added interaction state '{displayName}' ({cssSelector}) to '{ccLabel}'` · `Set default content for the '{slotKey}' slot` · `Added/Removed default styles` |

#### Tpl tree structure

| kind / subKind | template |
|---|---|
| NodeAdded | `Added {a <{tag}>\|a {componentName} instance\|slot "{paramName}"}{ into {parentLabel}}` |
| NodeRemoved | `Removed {nodeNoun} {lastLabel} from {fromLabel}` |
| NodeMoved | `Moved {label} from {fromLabel} into {toLabel}` |
| NodeRenamed | `Renamed {nodeNoun} {before} → {after}` · `Cleared the name of {nodeNoun} {before}` |
| TagChanged | `Changed {label} from <{before}> to <{after}>` |
| TagSemanticTypeChanged | `Turned {label} into {a text block\|an image\|a plain container}` |
| NodeLocked | `{Locked\|Unlocked} {label}` |
| TextChanged: set/bound | `Set text of {label} to "{excerpt}"` · `Bound text of {label} to an expression` |
| TextChanged: allowRawHtml/inlineNodeWrapped/inlineStyled | `Allowed raw HTML in {label}` · `Wrapped text in {label} as an inline {childNoun}{ over {n} chars}` · `Styled a run of text in {label}{ over {n} chars}` |
| AttrChanged | `Set {attrName} of {label} to {value}` **⚠key (attrName)** → degrades to `Set an attribute of {label} to {value}` |
| HandlerChanged | `{Added\|Changed\|Removed} the {eventName} handler on {label}` **⚠key (eventName)** |
| ArgChanged | `Set prop {propName} of {componentLabel} to {value}` **⚠key + entity-key (State)** |
| RepeatChanged: enabled/disabled/collection/varRenamed | `Repeated {label} over {collection}` · `Stopped repeating {label}` · `Repeated {label} over {after} instead` · `Renamed the repeat {item\|index} variable {before} → {after}` |
| SpreadChanged | `Added a prop spread on {label}{ from {sourceLabel}}` · `Prop spread on {label} now {overrides literal props\|excluding {key}}` |

#### Styling / RuleSet / layers

| kind / subKind | template |
|---|---|
| StylePropertyChanged | `On {targetLabel}{variantClause}: {propConcept} {valueDelta}` (`"2px wider"`, `"set to oklch(…)"`) **⚠key (CSS prop) + variant ⚠key (rs-map key)** |
| SizingModeChanged | `On {targetLabel}: {axis} sizing → {fill container\|hug contents}` · page-size: `fixed height\|wrap to content\|stretch to fill` |
| LayoutSupersetChanged | `On {targetLabel}: {irConcept} {valueDelta}` (`"horizontal padding 4px more"`, `"padding now measured inside the border"`) |
| DisplayVisibilityChanged | `On {targetLabel}: {hidden\|hidden but keeps its space\|removed from layout\|clip overflow to silhouette\|shown}` |
| StyleMarkerChanged (default) | `On {targetLabel}: {humanizedKey} {valueDelta}` (degrade-safe for unmodelled markers) |
| StyleExpressionBound | `On {targetLabel}: {propConcept} now {bound to an expression\|linked to {tokenName}}` · `… no longer dynamic` |
| BoxRecipeChanged / TextStyleChanged | `On {targetLabel}: box recipe → {boxTokenName}` · `text style → {styleName}` · `… removed` |
| SurfaceTokensChanged | `On {targetLabel}: {added\|removed} the {tokenName} {surface\|effects} pack` |
| LayerChanged: bg/shadow/filter/mask/transform/svg/gradientStop | `On {targetLabel}: added a {bgKind} background\|a{n inset} shadow\|a {kind}{ backdrop} filter\|a mask layer\|a {kind} transform\|a color stop` · edits read as deltas: `shadow blur 8px → 12px (softer)`, `moved {axis} by {value}`, `stop moved to {N}%` · `removed …` · `reordered {layerKindPlural}` · `swapped reference → {referencedTokenName}` |
| TransitionChanged | `On {targetLabel}: added a {duration} {easingWord} transition` · `transition {faster\|slower} ({Δ})` · `removed the transition` |
| MotionChanged | `On {targetLabel}: added an animation on {propConcept} ({start}→{end})` · `animation now passes through {value} at {percent}%` · `animation {duration} {easingWord}, {loops\|plays N×}` |
| EffectsScalarChanged | `On {targetLabel\|this element}: opacity {before} → {after}` · `blend mode → {value}` |
| SelectorChanged | `On {targetLabel}: targets {selector}` · `custom selector removed` |
| LayerOverrideChanged / LayerVisibilityChanged | `On {targetLabel} (this variant): override {field} on {layer} → {value}` **⚠tuple-key (doubly blocked)** · `hid {layerDescription}` |

#### Tokens & Theme

| kind / subKind | template |
|---|---|
| TokenCreated: scalar/gradient/composite | `Added {tokenNoun} '{name}'{ — {baseValue}}` · `Added gradient '{name}' ({type})` · `Added {shadow token\|box recipe\|typeface\|text style\|…} '{name}'` |
| TokenRenamed | `Renamed {tokenNoun} {before} → {after}` · `Named the {tokenNoun} → {after}` (null→name) |
| TokenDeleted | `Deleted {tokenNoun} '{name}'` |
| TokenValueChanged | `{tokenName}: {domainDelta}` (`"blur 8px → 12px (softer)"`, `"angle 90° → 135°"`, `"→ oklch(…)"`, `"now repeating"`) |
| TokenVariantValueSet | `{tokenName}: {comboLabel} value {set → {after}\|changed {before} → {after}}` |
| TokenValueCleared | `{tokenName}: removed {comboLabel\|field} override (falls back to base)` |
| TokenAliased | `{tokenName}{ {atCombo}} now points at {targetTokenName}{ (was {wasLiteral})}` |
| TokenCompositionChanged | `{tokenName} {now extends\|no longer extends\|reordered its bases:} {otherTokenName}` |
| TokenExportTierChanged | `{tokenNoun} {name}: {exposed as beta\|promoted to stable\|demoted to beta\|unpublished}` |
| TokenClassificationChanged | `Token {name}: {classified as {valueKind}\|{cluster} cluster\|+tag '{t}'\|re-typed {before} → {after}}` |
| PaletteChanged: created/baseChanged/stepsChanged/descriptionEdited | `Added {color palette\|palette recipe} '{name}'{from {recipe}}` · `Palette '{name}': reseeded to {color\|token}` · `Recipe '{fn}': {added\|removed\|renamed\|reworked} step '{step}'` · `Palette '{name}': description {set\|updated\|cleared}` |
| FontChanged: uploaded/faceChanged/labelsEdited | `Uploaded font '{name}' ({faceSummary})` · `Font '{name}': {added\|removed} {faceDescriptor}` · `Font '{name}': labeled {tag} '{label}'` |
| AssetChanged: added/edited | `Added {icon\|image} '{name}'{ from {source}}` · `Asset '{name}': {renamed → {after}\|+keyword '{kw}'\|reclassified as {type}}` |
| ThemeElementDefaultChanged | `Default text style for {tagLabel}: {set to\|changed to\|cleared from} {textStyleTokenName}` (`:root → "the page root"`, `h1 → "every h1"`) |

#### Params / States / Types

| kind / subKind | template |
|---|---|
| StateAdded | `Added {global }{variable\|prop\|derivation\|variant group} '{name}'{ (a {friendlyType})}` |
| StateRemoved / StateRenamed | `Removed {kind} '{name}'` · `Renamed {kind} '{before}' → '{after}'` |
| StateExposureToggled | `'{name}' is now {a public prop\|an internal variable}` |
| StateDefaultChanged | `'{name}' {default\|preview value} → {renderedExpr}` · `… cleared` |
| StateDerivationMarked | `'{name}' is now {a derivation\|an ordinary variable}` |
| TypeChanged | `Retyped '{name}': {friendlyBefore} → {friendlyAfter}` · `the {name} arg is now opaque (untyped)` |
| ChoiceOptionsChanged / UnionValuesChanged | `'{owner}' options: {added\|removed} '{label}'` · `'{group}' cases: {added\|removed} '{value}'` |
| FeatureFlagBindingChanged | `Bound {owner} to the '{provider}' feature-flag source (key '{key}')` · `Unbound …` · `Remapped the '{provider}' flag binding` |
| FormSchemaChanged / FormRuleEdited | `Form '{name}': {added\|removed} field '{fieldName}'\|a cross-field rule` · `Form '{name}' rule: message → "{text}"` |
| ClassNameSelectorsChanged / DefaultStylesChanged | `'{owner}' selectors: {added\|removed} '{selector}'` · `'{owner}' default styles: {set N props}` **⚠key (CSS prop)** |
| HtmlTagConstraintChanged | `'{owner}' default tag <{before}> → <{after}>` · `'{owner}' {allows\|no longer allows} <{tag}>` |
| ColorDerefToggled / RefKindToggled | `'{owner}' color: {kept raw (no token deref)\|resolved through tokens}` · `the {slotName} ref is now a {callback ref\|ref object}` |
| SlotAdded / SlotRemoved / SlotReordered | `Added {arg\|a group of args\|a tuple of args\|a switch} '{slotName}' to {ownerName}` · `Removed …` · `Reordered {args\|fields} in {ownerName}` |
| SlotBindingChanged | `the {slot} labeled as '{new}'` · `wire name '{before}' → '{after}'` |
| SlotRequiredToggled / SlotPriorityChanged / SlotRoleChanged | `'{slotName}' is now {required\|optional}` · `Adjusted display order of '{slotName}'` · `the {slotName} callback is now {a signal source\|an ordinary callback}` |
| SlotDefaultChanged / ArgSwitchArmsChanged | `'{slotName}' {default\|preview value} → {renderedExpr}` · `{switch} arms: {added\|removed} arm '{value}'` |
| ReturnShapeChanged / ReturnStateWiringChanged | `{callable} output: {added\|removed} '{fieldKey}'` · `'{fieldKey}' now reads {targetName}` · `{callable}: paired a read↔write half` **⚠key (read-half)** |
| EmitterChanged | `Declared '{slotName}' as a {node\|browser}-style event emitter` · `emitter exposes event '{eventName}'` · `event '{name}' now carries {friendlyType}\|is now fire-only` |

#### Variants & Environments

| kind / subKind | template |
|---|---|
| VariantAxisChanged: added | `Added {site-wide }variance axis "{groupName}" driven by {subjectPhrase}{ (single on/off toggle)}` |
| VariantAxisChanged: removed/renamed/toggleMode/subjectRebound/promoted | `Removed variance axis "{name}"{ (and its N variants)}` · `Renamed variance axis "{before}" → "{after}"` · `axis "{name}" is now {a single on/off toggle\|a multi-option choice}` · `axis "{name}" now reacts to {newSubject} (was {oldSubject})` · `Promoted variance axis "{name}" from {owner} to site-wide` |
| VariantChanged: added | `Added variant "{variantName}" to "{groupName}"{ (when {condition})}` |
| VariantChanged: removed/renamed/condition/description | `Removed variant "{name}" from "{group}"` · `Renamed variant "{before}" → "{after}"` · `Variant "{name}" now matches when {subject} {operatorPhrase} {value}` · `Described variant "{name}": "{text}"` |
| PseudoStateStylingChanged | `Enabled :{pseudo} styling on {componentLabel}` · `Removed :{pseudo} styling from {componentLabel}` **⚠key (pseudo name)** |
| VariantPrecedenceReordered | `Reordered variant precedence on {owner}: "{axis}" now {overrides\|is overridden by} "{other}"` |
| LifecyclePredicateClauseChanged | `Lifecycle hook now fires {when\|unless} "{groupName}" is {values}` |
| VariantCombinationChanged | `Targeted the {variantNames} variant combination` *(cross-area — see §4)* |

#### Behavior / Interactions / Expressions

| kind / subKind | template |
|---|---|
| WiredEventHandler | `On {event}, {summarizeIntents} on '{ownerTplLabel}'{ (variant)}` |
| ReactiveHandlerAdded | `When {signals} change, {effect} (on {parent})` · `On {app\|component} mount: {effect}` · `While {predicate}, {effect}` |
| InteractionStepChanged | `Added step '{name}': {action}{ when {condition}} to the {event} handler on '{owner}'` · `Renamed interaction step '{before}' to '{after}'` · `Changed step '{name}' from {oldKind} to {newAction}` · `Step '{name}' now runs only when {condition}` |
| NavigationChanged | `Navigation goes to {destination}` · `Navigation now opens in {a new tab\|the same tab}` |
| CustomCodeActionEdited | `{structured action summary}` · `Code action: {code}` |
| InvokeOperationChanged | `Step now calls {operationLabel}` · `Set {operationLabel} arg {argSlot} to {expr}` |
| QueryInvalidationChanged | `Refetch all queries after this step` · `Refetch {queryLabels} after this step` |
| HandlerInternalsChanged | `Edited the handler {phase} code: {code}` · `Added step … to the {handler}` · `Handler concurrency: {phrase}` · `Handler now also reacts to {signal}` · `Lifecycle effect now fires {predicate}` |
| ExpressionEdited | `Added {x} to the list expression` · `Set {key} = {x} in the object expression` · `Link route: {pageHrefDescribe}` · `Bound parameter {argSlot} to {expr}` |
| BehaviorSubtreeRemoved | `Removed the {kind} {label} from '{owner}'` |

#### Data / Queries / Operations / Integrations & Collaboration

| kind / subKind | template |
|---|---|
| DataSourceChanged: add/relabel/chain | `Added {query\|mutation\|custom hook\|imported} data source "{label}"{ in {category}}` · `Renamed data source "{before}" → "{after}"` · `"{name}" now extends "{parent}"` |
| DataSourceChanged: add-inline-fetcher/point-at-function/set-fetch-kind | `Gave "{name}" an inline {kind} fetcher` · `Pointed "{name}" at imported function {path}` · `"{name}" is now a {after} (was a {before})` |
| DataSourceChanged: set-invalidation/link-external/configure-custom-type | `On success, "{name}" refreshes the {target} cache` · `Linked "{name}" to its external request ({url})` · `Configured custom hook "{name}" (gate: {…})` |
| DataSourceChanged: import-api-provider | `Imported {provider} API ({N} endpoints{, {category}})` |
| QueryChanged: add/rename/bind-source | `Added query "{name}"{ (calls "{dsd}")} to {component}` · `Renamed query "{before}" → "{after}"` · `Query "{name}" now calls "{dsd}"` |
| QueryChanged: bind-argument/set-gate/wire-node-ref | `Wired an argument on query "{name}"` **⚠key** · `Set an activation gate on query "{name}"` · `Attached query "{name}" to element "{node}"` |
| OperationChanged: add/relabel/set-kind | `Added {kind} "{label}" ({sourceSummary})` · `Renamed {kind} "{before}" → "{after}"` · `"{name}" is now a {after} (was {before}) — {now has\|no longer has} lifecycle states` |
| OperationChanged: edit-signature/set-invalidation/repoint-source | `Changed the parameters of "{name}" (now N parameters)` · `On success, "{name}" refreshes the {target} cache` · `"{name}" now comes from {sourceSummary}` |
| ImportChanged: npm-package/bump-version/function | `Added npm package {name}@{ver}` · `Updated {name}: {before} → {after}` · `Imported {kind }function {path} from {pkg}` |
| ImportChanged: code-library/retarget/cache-types/hostless | `Added code library "{name}" ({importType} import of {path})` · `Repointed import → {after}` · `Loaded type definitions for {name}` · `Registered hostless package "{name}" ({N} npm deps)` |
| ProjectVariableChanged: add/edit | `Added project variable "{name}" ({type})` · `Default of "{name}" → {value}` · `"{name}" bound to env var {after}` · `Retyped "{name}" → {type}` |
| SplitChanged: add/set-status/edit/edit-slice/rebalance | `Created {type} "{name}" ({N} variants)` · `Started experiment "{name}"` · `Renamed split …` · `Added slice "{name}" to "{split}"` · `"{split}" slice "{name}" traffic {before}% → {after}%` |
| CommentEvent: post/reply/edit | `{author} {commented\|opened a task\|left a review note} on {anchor}: "{excerpt}"` · `{author} replied: "{excerpt}"` · `{author} edited a comment` |
| CommentEvent: react/resolve/taskFields | `{author} reacted to a comment` **⚠key (emoji)** · `{resolver} {resolved\|reopened} a thread on {anchor}{ ({reason})}` · `Assigned a task to {assignee}` |
| CommentEvent: archive/delete/reanchor | `{Archived\|Unarchived} a thread on {anchor}` · `{Deleted a thread\|Hid a comment\|Deleted a comment}` · `Moved a thread to {anchor}` |

---

## 4. Coverage report

### 4.1 Fully covered

- **The materialize-cascade collapse** (the canonical target) — proven against the e2e add-Card
  fixture (16→1), and applied uniformly: component / page / code-component add, token create, arena +
  artboard add, variant-axis + pseudo-state add, font upload, palette + recipe create, data-source +
  API-provider import, operation + npm/code-library import, project-variable + split + comment create.
  Each is one EMIT anchor + N MERGE + M DROP.
- **Birth-vs-edit discrimination** via `FRESH` / `before`-presence — every `*Added` vs `*Renamed` vs
  `*Changed` split, totalically, across all nine areas. No field is bucketed.
- **`∅→default` and empty-container DROPs** — enumerated per area; aligned with the lift already
  skipping empty `Y.Array`/`Y.Map` and with Plexus's null-as-delete.
- **Removal + subtree cascade** — one `*Removed` per deleted subtree root, descendants MERGE by
  ancestry; labels via `valueAsOf` point-in-time.
- **Genesis namespace DROP** — the clean O(1) uuid-clientId filter (`isGenesisClientId`) resolves the
  environment-seed plumbing decisively.
- **Domain-aware humanization** — dimension deltas (`"2px wider"`), state phrasings (`"locked"`),
  route rendering (`"/landing"`), token/component/page names (never uuids), data-driven marker
  concepts off `IR_STACK_FAMILIES`.

### 4.2 Open — needs a V / product decision

1. **Genesis-of-the-project event** — does `ProjectCreated` EMIT, or does the lens snapshot genesis as
   t0 (the ~10 bootstrap changes simply never in range)? *Default stance:* EMIT behind a config flag.
2. **Variant toggle = one event or two?** A variant-add that sets both `standalone` and a condition in
   one cut — one `VariantChanged:added` (current) or split. Also: reparent+rename in one cut emits two
   lines (`NodeMoved` + `NodeRenamed`) — collapse or keep?
3. **`VariantsCombination` ownership** — its parent is `ArgsSet` (render-tree node activation), not a
   variants entity. Likely belongs to the render-tree/node-activation area; `VariantCombinationChanged`
   is provisionally emitted here with a **double-emission risk** flagged. Needs a cross-area dedupe call.
4. **Action-level query invalidation** — `InvalidateQueryAction` / `QueryInvalidationSelector` live
   under a behavior Action; the Data area MERGEs them out. But `invalidateAll:true` ("refresh all
   queries") has no EMIT home as drawn. Decide whether data-flow invalidation surfaces in the Data log.
5. **Metadata / comment salience** — `Component.metadata` and comment keys may carry machine-written
   importer stamps; a salience-layer allowlist could DROP specific keys. Until then all EMIT.
6. **`represents` tag on arg-shape nodes** — a no-codegen-effect curator annotation; EMIT terse or DROP
   entirely? Weakest EMIT in the set.
7. **`Site.userManagedFonts`** — string-Set of family names, Tokens-area-adjacent but holds no
   entities; in-scope as a tiny font intent, or a separate settings area? Currently DROP.
8. **Within-cut vs across-window coalescing** — debounced text typing and multi-step drags span
   multiple cuts; the lens needs a `groupBy("burst")` policy (e.g. "≥3 same-kind value-changes in one
   txn → summarize 'Adjusted N spacing tokens'"). Threshold unset.

### 4.3 Open — **blocking lift dependencies** (the lens cannot work around these)

These recur across **six** of the nine areas and are the single most important findings:

1. **★ MAP/RECORD ENTRY KEY IS LOST.** `lift.ts`'s `resolveContainer` returns `field` = the *map's
   own field name* (`owner.parentSub`, e.g. `"attrs"`/`"args"`/`"_values"`/`"defaultStyles"`/
   `"reactions"`/`"externalLinks"`/`"flags"`) and the **value** in `before`/`after`, but **discards the
   `Y.Map` entry key** (the inner item's `parentSub` — the attr name `href`, the event name `onClick`,
   the CSS prop `padding-left`, the flag name, the reaction `user:emoji`, the read-half wiring key).
   **Blocks ~15 humanizations** across Styling (CSS prop), Tpl (`AttrChanged`/`HandlerChanged`/
   `ArgChanged`), Project/Site (`flags`/`dependencies`/`defaultComponents`/diagnostics records),
   Params (`stateWiring`/`matchSlots`), Variants (`pseudoVariantGroups`/`externalKeys`), Data
   (`externalLinks`/`reactions`/`nodeRefs`). **Fix:** widen `PlexusChange` with a `key?: string` for
   `map`/`record` containers (`resolveContainer` already has `item.parentSub` of the value item in
   reach). Until then those templates degrade to key-agnostic forms (marked **⚠key** in §3).

2. **★ NO `reorder` VERB IS EVER EMITTED.** `Verb` declares `"reorder"` (`types.ts:48`) but `liftFrame`
   only produces `insert`/`remove` for arrays. A Yjs `Y.Array` move surfaces as `remove(uuid) +
   insert(same uuid)` in one cut. The lens **reconstructs** reorder (same-uuid remove+insert, no
   co-materialize/detach) — but (a) a genuine remove-then-readd-same-entity is indistinguishable;
   (b) a 1-element "reorder" produces no change; (c) **no index/position** is carried, so direction
   ("moved up") is unrecoverable. Affects arena/artboard/layer/slot/option/precedence/manifest
   reorders everywhere. **Fix:** emit a real `reorder` verb with `{from,to}` indices, or accept
   direction-less + the false-positive risk.

3. **Entity-keyed maps need a second resolver pass.** `ArgsSet.args` is keyed by a `State` entity,
   `TplComponent.slots` by a `SlotParam` entity (serialized `Value:<uuid>` map keys). Even with the
   key fix, the lens must *resolve that entity to its name at the seq* — a resolver beyond
   `decorate`'s `entity`/`from`/`to`.

4. **Refs in `before`/`after` are not auto-labeled.** `decorate` labels only `entity`/`from`/`to`. A
   plain ref sitting in a `set`'s `after` (e.g. `ReturnSlot.target`, `CrossFieldRule.slots` elements,
   `VariantGroup.subject`, `defaultExpr` child uuids, `DataSourceDefinition.extends`) must be
   `deref`-ed + laddered by the **lens itself** via `valueAsOf` + the model + `displayNameLadder`.
   This is a real machinery dependency (the lens needs archive-read keyed by uuid+seq), not a hook call.

5. **`reparent`/`detach` drop the field-key tuple.** The lift resolves only `tuple[0]` (parent uuid),
   not `tuple[1]` (which child-list the entity sits in). For most areas `parent.type` disambiguates
   (`Site`→`arenas` vs `Arena`→`children`); a generic consumer cannot tell which of a parent's
   multiple child-lists received the child.

6. **Cross-doc + author resolution is external** (Collaboration). `Comment.authorUserId` /
   `anchorTargetId` resolve via **injected** host resolvers (a user directory + a cross-doc anchor
   resolver into the prime doc) that may return null (stale). Not in `PlexusChange`; all comment lines
   degrade gracefully ("a collaborator" / "a deleted element") without them.

7. **Transaction-grouping contract must be confirmed.** All §2 clustering is `groupBy(seq)`, valid iff
   one user gesture = one `studioCtx.transact()`. The e2e add-Card proves it for component creation;
   it must be a *hard invariant* (or a gesture split across transactions over-/under-merges — e.g. two
   pasted artboards → one event, or create-then-rename → spurious rename). Confirm against
   `TplMgr`/`siteOps` for the multi-step ops (provider import, `createSplit`, `Comment.create`).

### 4.4 Mechanical corrections folded in (vs the original ideated cases)

- `locked` on the root `TplTag` is `boolean|null` with **no `=false` initializer** → birth value is
  **`null`**, not `false` (the canonical-16 example's "locked ∅→false" is wrong, though the DROP is
  the same).
- Record/set/list fields surface as `insert`/`remove`, **never** `set`/`clear` (those are
  XmlElement-attribute-only) — every diagnostics/flag/dependency/role/option rule rewritten.
- `exportTier`, PageMeta SEO fields, optional `SlotParam` fields are scalars → clearing is `set
  after:null` / `clear`, **not** a `clear` verb on a child.
- `RandomSplitSlice.prob` is a **percentage 0–100**, not a 0–1 fraction (`prob*100` would render
  5000%).
- `Site.hostLessPackageInfo` is a **single `@syncing.child`**, not a list.
- Genesis is detectable by **uuid-namespace** (`isGenesisClientId`), not by `author===null` (real
  pure-delete detaches also have `author===null`).
- Added cases the ideation missed: `site.roleUnbound.cascade` (auto-unbind on component delete →
  DROP), `frameconfig.normalize.plumbing` (sibling-frame reposition → DROP), `artboard.autoscreen`
  (width-driven target toggle → MERGE), `provider.config.changed`, `EffectsScalarChanged` (opacity /
  blend), `SelectorChanged`, and the **missing top-level-delete EMIT rules** for
  DataSource/Operation/Query/NpmPackage/CustomFunction/Definition/Split (flagged in §4.2, mirror the
  `*.add` rules in reverse).

---

## 5. Layering

```
experiments/plexus-history/
├── core/         domain-AGNOSTIC. Yjs archive → PlexusChange[]. Knows CRDT shapes
│                 (materialize/set/clear/reparent/detach/insert/remove), point-in-time,
│                 cut-log, decorate hook. Knows NOTHING of TplTag/RuleSet/Comment.
└── lens/         here.build-model-SPECIFIC (this doc). Consumes core's PlexusChange[],
                  encodes here.build semantics (the 9 areas), emits IntentEvent[].
                  Owns the CSS lexicon, the marker→concept table, the tokenNoun map,
                  the comment author/anchor resolver injection points.
```

The clay tenet: **core stays domain-agnostic**; all here.build knowledge (what a `PlainComponent`
materialize *means*, that `RuleSet` eager-seeds `Surface`+`Effects`, that `prob` is a percentage)
lives **only** in the lens. The blocking gaps in §4.3 that require core changes (the map key, the
reorder verb) are widenings of the *domain-agnostic* `PlexusChange` shape — they stay in core and
remain domain-blind; the lens consumes the richer-but-still-agnostic change.
