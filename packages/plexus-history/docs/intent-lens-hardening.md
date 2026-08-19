# The Intent Lens — Wave-3 Hardening Record

> Status: hardening pass, 2026-06-24. Diff against the wave-1 baseline
> (`intent-lens-design.md`, which stays the canonical design). This record is the result
> of 9 per-area adversarial verifications + 1 completeness critic, **re-verified against the
> model source and `experiments/plexus-history/core/src/lift.ts` + `operators.ts`** (not the
> doc's prose). Where a kill is marked **VERIFIED**, I read the cited model file or core
> source myself this pass; where **PARTIAL**, the mechanism is confirmed but a value/threshold
> is still V's call.
>
> **Headline verdict:** the two-layer architecture (core = CRDT-blind `PlexusChange[]`, lens =
> here.build semantics) is sound and survives. The **disposition philosophy**
> (EMIT-anchor / MERGE-children / DROP-defaults, FRESH-by-cut discriminator) is the right
> shape. But the baseline **overstates totality and ships several DB-diff leaks**, and its
> flagship proof (the 16→1 add-Card) is **fabricated** — derived from neither the toy e2e
> (which emits 18, incl. a root-tag rename) nor the real `TplMgr.addComponent` (which seeds
> CSS on the root RuleSet). Three core-lift gaps (map-key loss, no reorder verb, refs-in-`after`
> unlabeled) bite harder and wider than §4.3 admits. None are fatal; all are fixable. The
> wave-2 survey's 165-NEW figure is inflated ~20-30% (it never counted VariantOps / operations/ /
> studioCtx-direct mutations).

---

## 0. What the re-verification confirmed in core source (the load-bearing facts)

Every per-area kill rests on a handful of `lift.ts` / `operators.ts` behaviors. I read them this
pass; they hold:

| claim | source | verdict |
|---|---|---|
| **Map/record entry key is discarded.** `resolveContainer` returns `field = owner.parentSub` (the map's own field, e.g. `_values`/`attrs`/`metadata`) and the *value* in before/after, but never the inner `item.parentSub` (the CSS prop / attr name / metadata key). | `lift.ts:44-54` | **VERIFIED** |
| **Record/map entries lift UNPAIRED.** Only `kind:"attr"` (XmlElement attributes) are paired into a single `set {before,after}` via `attrGroups`; array/map entries (`lift.ts:104-113`) emit `insert {after}` and `remove {before}` *separately*. A value EDIT of a record entry is indistinguishable from a birth-insert + unrelated remove. | `lift.ts:99-113` vs `116-141` | **VERIFIED** |
| **No `reorder` verb is ever produced.** `Verb` declares it (`types.ts`) but `liftFrame` only emits insert/remove for arrays. A Y.Array move = `remove(uuid)+insert(uuid)`, no index. | `lift.ts:104-113` | **VERIFIED** |
| **`reparent`/`detach` drop `tuple[1]`.** Only `tuple[0]` (parent uuid) is read; the child-list key (`slots`, `arenas`, `children`) is discarded. | `lift.ts:122-141` | **VERIFIED** |
| **`decorate` labels only `entity`/`from`/`to`, never `before`/`after`.** A ref sitting in `after` (token alias target, variant subject, operation ref) leaks a raw uuid unless the lens derefs it. | `operators.ts:114-120` | **VERIFIED** |
| **`null` is stored as attr-delete** (so many `∅→null` sets emit no change), but **non-null defaults DO reach the lens** (`set X ∅→false`/`""`). | `lift.ts:131-141` + e2e snapshot | **VERIFIED** |

These six are the spine. Everything below is a consequence.

---

## 1. KILLS APPLIED

Rules from the baseline that do not survive scrutiny, with the fix. Grouped by severity.

### 1.1 The fabricated flagship — §0/§2.5/§4.4 add-Card example (BLOCKER for the doc's credibility)

**VERIFIED against both paths.** The §2.5 "16 changes → 1 event" table is neither the toy nor
the real studio gesture. Three independent confirmations:

- **The toy e2e emits 18, not 16.** `e2e.test.ts:54` inline snapshot shows the real cut includes
  `TplTag renamed '∅' → 'root'` (a `name` set the §2.5 table omits entirely) AND
  `TplTag 'root' locked: ∅ → false` — because `ToyProjectDO.addComponent` (`ToyProjectDO.ts:66`)
  constructs `new TplTag({ tag: "div", name: "root", locked: false })`, explicitly passing both.
- **The real path seeds CSS.** `TplMgr.addComponent` (`TplMgr.ts:611-661`) does
  `new TplTag({ tag: "div" })` (no name, no locked), then `root.ensureRuleSet([])` followed by
  `rsh.set("display", "flex"/"block")`, `rsh.set("flex-direction", "column")`,
  `rsh.set("position", "relative")` (+ `width`/`height` "stretch"/"wrap" for page/frame) **in the
  same transaction**. Those reach the lens as `insert` changes on the root RuleSet's `_values`
  record — not `∅→default` (CSS-initial for `display` is `inline`, not `flex`), not the anchor's
  payload, not eager-seeded structure. They fall through every §2.2 MERGE and §2.3 DROP rule.
- **§4.4's "locked is ∅→null" correction is right for the model but contradicts its own cited
  e2e.** `TplTag.locked: boolean | null` has no `= false` initializer, so the *real* birth is
  `∅→null` (emits nothing). But the e2e the doc calls ground-truth shows `∅→false` because the toy
  passes `locked:false`. So the doc simultaneously cites the e2e as proof AND corrects it — the
  example is a third hand-built artifact aligned to neither.

**KILL + FIX:**
1. Stop citing "verified against e2e (16 changes)". Re-derive the canonical from
   `TplMgr.addComponent` (the real gesture). State which path the example models. The real add-Card
   is ~25 low-level changes (1 EMIT + N MERGE + M DROP + **3-5 leaked StylePropertyChanged unless a
   new MERGE rule is added** — see 1.2).
2. Add a §2.2 MERGE rule: **birth-time RuleSet value-sets on the anchor's root node** (owning
   RuleSet's owner ∈ FRESH) that establish the constructor's default layout shell
   (display/flex-direction/position/width/height) MERGE into `ComponentAdded`. They are the layout
   shell of "added a component", not independent style edits.
3. Keep the toy e2e as a *fixture-shape* example only, clearly labelled "(toy harness; real
   `TplMgr` path differs — no root-tag name set, plus CSS seeds)".

### 1.2 Record-entry EDITS are indistinguishable from births (BLOCKER — Styling, Tokens, Component-metadata)

**VERIFIED (`lift.ts:99-113`).** The entire `∅→default` DROP machinery and the felt-delta
templates assume a `set {before, after}` on a single field. For every `@syncing.record` /
`@syncing.child.record` / `@syncing.map` (`RuleSet._values`, `ColorToken.values`,
`StyleToken.values`, `TextStyleToken.values`, `ComponentBase.metadata`, `FilterLayer.params`,
`SVGFilterElement.attributes`, `Site.flags`, `externalLinks`, `reactions`, …) a value edit is
`map.set(key, new)` = tombstone-old + insert-new on the inner Y.Map, which the lift emits as **two
separate keyless changes** (`insert {field:_values, after:16px}` + `remove {field:_values,
before:8px}`), never paired. Consequence:
- a value edit looks exactly like a birth-insert + an unrelated remove;
- the direction delta (`"2px wider"`) is uncomputable (before and after live in two changes with no
  shared key to rejoin them — the key is lost too, 1.3);
- `∅→default` counting on records is impossible.
- The one proven fixture (add-Card) only exercises **attr** sets, so this failure mode is entirely
  untested.

**KILL + FIX (core, not lens):** make `liftFrame` pair same-key insert+delete within a Y.Map into
one `set {key, before, after}` — the map analog of the attr-grouping it already does — which
requires surfacing the per-entry key first (1.3). Until that lands, **demote every felt-delta
styling/token-value template to an explicit degrade** ("Card: styling changed (N properties)") and
stop asserting the §3 "never a DB diff" law is met for record-backed fields.

### 1.3 The map-key gap is THREE stacked gaps, not one (BLOCKER — Styling, Tokens, Behavior, Params, Tpl, Collaboration)

**VERIFIED.** §4.3 gap #1 frames the lost key as "add `key?: string`". That is necessary but
insufficient. There are three distinct key shapes:
1. **String inner key** (`_values` CSS prop, `metadata` key, `externalLinks` provider, `defaultStyles`
   prop) — `key?: string` carries it. ✔ the easy case.
2. **Entity-Set key** — `TplNode.rs: Map<Set<Variant>, RuleSet>`, `StyleToken.values: Map<Set<VariantString>, …>`,
   `TextStyleToken.values`, `ColorToken.values`, `PaletteFunctionStep.derivations`. The map key is a
   `Set` of *entity references* serialized `Set:<uuid>,<uuid>`. A flat `key?: string` surfaces an
   opaque `Set:p3:7,p9:2` blob, not "dark mode". Needs a structured `keyRefs?: EntityRef[]` AND
   `decorate` extended to label map keys (it currently only walks entity/from/to).
3. **Entity key** — `ArgsSet.args: Map<State, …>`, `TplComponent.slots: Map<SlotParam, …>`,
   `EventHandlersSet.eventHandlers` (callback-prop case keyed by a serialized State),
   `InvokeOperation.args: Map<ArgSlot, …>`. Even with the key surfaced it is a uuid that must be
   deref'd to the entity's name at the seq (§4.3.3's "second resolver pass").

**KILL + FIX:** split §4.3#1 honestly into the three. State plainly that **variant-scoped styling
and variant-keyed token values — the common case (hover/dark/breakpoint) — are unrepresentable
until both the structured key AND the decorate-over-map-keys land.** Extend `decorate` to walk map
keys, not just entity/from/to.

### 1.4 ArenaFrame birth discriminator is unsound — constructor writes NON-defaults (Arenas)

**VERIFIED (`FrameConfig.ts:8-12`).** `FrameConfig.viewMode!: "stretch"|"centered"|null`,
`width!`, `height!` — all declared with `!` (no initializer). `mkArenaFrame`/`deriveInitFrameSettings`
ALWAYS write a non-default viewMode at birth (Stretch for pages/stretchy, Centered otherwise) plus
800×500-ish width/height. §2.3.1's DROP test keys on `after === constructor default` — but there is
no constructor default; the birth value IS the only write. So artboard creation emits
`viewMode ∅→stretch`/`width ∅→800`, which §2.3.1 will NOT drop (after != default) and which collide
with the separate `ArtboardChanged:viewModeChanged`/`resized` EMIT rows → phantom "Set artboard to
centered" / "Resized to 800×500" on every artboard add.

**KILL + FIX:** the birth gate must be **`uuid ∈ FRESH` only**, never "after === default". For a
FRESH ArenaFrame, ALL of its FrameConfig sets (viewMode/width/height/left/top) + targetGlobalVariants
inserts MERGE into `ArtboardChanged:added` **by ancestry** (`FrameConfig.owner ∈ FRESH`), regardless
of value. The "after === default" clause in §2.3.1 is unsound for *any* entity whose constructor
writes non-defaults — generalize the fix: birth = FRESH, full stop; "after === default" is only a
secondary DROP for *edits on non-fresh entities* reverting to default.

### 1.5 Phantom field: `condition ∅→true` (Variants)

**VERIFIED (`Variant.ts:62-76`).** No `condition` field exists on any variance entity. A Variant's
condition is `(operator, right)`: `operator: VariantOperator | null = null` and
`right: … | null = null` (`@syncing.child`). The §2.3.1 DROP list invents `condition ∅→true` and
misses the two real birth changes: `operator ∅→null` (a true DROP) and `right ∅→<CustomCode child>`
(a MERGE).

**KILL + FIX:** delete `condition ∅→true`. Replace with `operator ∅→null` (DROP). Add
`Variant.description ∅→null` (VERIFIED: `description!: string | null`, no initializer, written at
every birth) to the DROP set. Note `right` birth is a child materialize that MERGEs.

### 1.6 Comment delete/resolve/archive are scalar SETs, never detach (Collaboration)

**VERIFIED (CommentsRepo.delete sets `comment.visibility = "deleted"`).** §2.4 routes deletion via
`verb===detach`/collection `remove`, and the cascade-collapse rule keys on detach. But comment
"delete" is a `set` on the `visibility` scalar enum (`"visible"|"hidden"|"deleted"`), and a thread
delete tombstones the root + ALL replies as **N+1 `set visibility=deleted`** in one cut. Nothing in
§2 routes `set visibility=deleted` → `CommentEvent:delete`, and the detach-cascade rule never fires
(no ownership change). Same for `resolution`→resolve/reopen, `archived`→archive/unarchive.

**KILL + FIX:** add an explicit Collaboration field→subKind table:
`visibility→{deleted:delete, hidden:hide}`, `resolution→resolve/reopen`,
`archived→archive/unarchive`, `assignedTo/dueAt/intent→taskFields` — routed by the `set`, not the
generic before-present→*Changed path. Add a same-cut coalescing rule: multiple
`set visibility=deleted` sharing a thread root collapse to one `CommentEvent:delete`. Also **split
hide from delete** (different reversibility — a hidden comment recovers, a deleted root cascades).

### 1.7 Fresh child of a NON-fresh parent has no disposition (Data, Component, Tpl, Tokens)

**VERIFIED structurally.** §2.2 rule 1 MERGEs "child materializes whose parent is the anchor", where
anchor = a FRESH identity-bearing materialize. §2.4 then says `uuid ∈ FRESH → anchor → EMIT *Added`.
But many gestures materialize a fresh child under an *existing* (non-fresh) parent:
- `ValueOperation.source` repoint (new `OperationSource` child on an existing op),
- `DataSourceDefinition.type` adopt (string→`DataQueryFetch`/`CustomFunction` inline entity),
- `ComponentTemplateInfo` materialize when marking an existing component as a template,
- `FigmaComponentMapping` materialize when linking Figma on an existing component,
- `Rep`/`RepElement`/`RepIndex` materialize on enabling repeat,
- TplComponent slot-fill wrapper `new TplTag({tag:"div"})` (`TplNode.ts` `ensureSlotArg`).

The fresh child is in FRESH, its parent is NOT → it falls through to EMIT its own spurious `*Added`.

**KILL + FIX:** add a §2.2 rule for the **"fresh child of a non-fresh parent"** class: a
child-materialize whose parent ∈ (non-fresh, edited-this-cut) and which lands in a single-valued
child slot (optionally with a simultaneous detach of the prior occupant) MERGEs into the parent's
`*Changed` event (repoint-source / point-at-function / template-marked / figma-linked /
repeat-enabled). This is a **distinct anchor class** from the FRESH-parent merge and must be stated.
Gate the "MERGE child into parent" rule on **parent ∈ FRESH**; otherwise the child-materialize is an
EMIT anchor for a `*Changed` on the parent.

### 1.8 Multi-anchor cuts have no precedence rule (Arenas, Variants, Params)

**VERIFIED (`siteOps.createFrameForComponent` + `StatesTab.addVariant`).** §0.2 asserts one gesture =
one cut = one cluster, but the dominant gestures fire **multiple peer EMIT anchors** in one cut:
- "create artboard for new component" = `site.addArena()` + `addNewMixedArenaFrame` + `addComponent`
  → a fresh Arena (`ArenaChanged:added`) + a fresh ArenaFrame (`ArtboardChanged:added`) + a fresh
  Component (`ComponentAdded`).
- "add a variant axis" = `new State(...)` pushed to `component.states` + `new VariantGroup({subject:
  state})` pushed to `component.variantGroups` → a fresh State (`StateAdded:variant-group`, Params
  area) + a fresh VariantGroup (`VariantAxisChanged:added`, Variants area). Names identical (the group
  copies subject.name) → guaranteed double-emission.

§2.2 MERGE only folds children INTO a single anchor; there is no rule for multiple *peer* anchors.

**KILL + FIX:** add cross-anchor precedence rules:
- Arena+ArenaFrame+Component: when a fresh Arena's only child is a fresh ArenaFrame whose container
  points at a fresh Component, MERGE the Arena+ArenaFrame into `ComponentAdded` ("Added component X
  (on a new canvas)"). Distinguish from standalone `addArena()` (blank canvas, no fresh frame) which
  legitimately EMITs `ArenaChanged:added`.
- State+VariantGroup: a fresh State in the same cut as a fresh VariantGroup whose `subject` ref points
  at it MERGEs into `VariantAxisChanged:added`. **Remove `{variant group}` from `StateAdded`'s
  subKind set** and let the Variants area own all axis births (`State.ts` itself says "a State with
  discrimination type IS a variant group"). The Params area defers by construction.

### 1.9 Cross-area reparent routing is verb-shaped, not entity-typed (Arenas, Variants)

**VERIFIED structurally.** §2.4's "reparent with `from` present → NodeMoved" rule is keyed on the
*verb*, not the entity type. But:
- `moveFrameToArena` reparents an **ArenaFrame** origin→dest → must route to `ArtboardChanged:moved`,
  not `NodeMoved` (wrong area, wrong template).
- `promoteVariantAxis` reparents a component-local **VariantGroup** → Site → must route to
  `VariantAxisChanged:promoted`, not `NodeMoved`.

Without an `entity.type` guard ahead of the NodeMoved rule, both emit a spurious NodeMoved.

**KILL + FIX:** gate the reparent discriminator on `entity.type` FIRST:
`ArenaFrame & from.type===Arena & to.type===Arena` → `ArtboardChanged:moved`;
`VariantGroup & to.type===Site` → `VariantAxisChanged:promoted`;
`TplNode` → `NodeMoved`. Also suppress co-cut `normalizeMixedArenaFrames` sibling top/left rewrites
(plumbing) when a move/add/remove anchor is present in the cut.

### 1.10 `ArenaChanged:reordered` has neither a gesture nor a verb (Arenas)

**VERIFIED.** No `arenas.splice`/`moveArena`/reorder op exists in studio (arenas are only `push`ed and
`remove`d), and §4.3.2 confirms the core never emits a reorder verb — a Y.Array move surfaces as
`remove(uuid)+insert(uuid)` with no index. The template's `({name} moved)` implies positional
knowledge the lift structurally cannot provide.

**KILL + FIX:** drop `ArenaChanged:reordered` until a real reorder verb with `{from,to}` indices
exists, or downgrade to direction-less and gate behind the reorder-reconstruction heuristic with the
false-positive caveat. Same applies to intra-arena frame reorder and intent-bag reorder (Behavior).

### 1.11 Unreachable Project/flag events oversell totality (Project/Site)

**VERIFIED (`Site.flags` has zero studio writers; `ProjectPackage.name` has no synced writer).**
`ProjectCreated`/`ProjectRenamed` back onto `ProjectPackage.name` — the doc *root* the lift skips
(`lift.ts:90` returns null for root/typeMap-level structs) and which has no studio writer (name is
managed via API/DB). `SiteFlagToggled` backs onto `Site.flags` — a `@syncing.record` with no writer,
and the canonical victim of the map-key loss (the flag NAME is the discarded inner key).

**KILL + FIX:** mark `ProjectCreated`/`ProjectRenamed` as **out-of-model** (resolved from the API/DB
layer via an injected resolver, like the comment author) or explicitly t0-snapshot only — do not
imply they derive from `PlexusChange[]`. Mark `SiteFlagToggled` speculative (no gestures + key-blocked)
and ensure any value-only fallback reads "Changed a project setting", never "Set _ to true".

---

## 2. HUMANIZATION REWRITES (templates that read like a DB diff)

Every line below is the **shape** fix (DRAFT–V-REVIEW; wording is V's). The defect is mechanical: a
raw value/enum/uuid/JSON leak, a non-domain phrasing, or a helper the catalog never defines.

### 2.1 Undefined helpers referenced by templates (catalog gap)

| helper | referenced by | the leak | fix |
|---|---|---|---|
| **`friendlyType(type)`** | StateAdded, TypeChanged, EmitterChanged, ProjectVariableChanged retype | renders `Type.name` = machine tokens (`dateRangeStrings`, `htmlTag`, `queryData`, `func`) | Add to §3.1 a full table over ~21 type members: `dateRangeStrings→"date range"`, `htmlTag→"HTML tag"`, `queryData→"query result"`, `func→"callback"`, `num→"number"`, `bool→"true/false"`, `className→"CSS class"`, `instance→"component"`, … Field-bearing types fold detail (ChoiceType.options count). |
| **`subjectPhrase`** | VariantAxisChanged:added, VariantChanged:condition | renders `MediaEnvironment.property` = camelCase `prefersColorScheme` | media-feature → phrase table (NOT the camelCase id); State→state name; CustomCode→exprSummary. |
| **`operatorPhrase`** | VariantChanged:condition | leaks raw `>=`/`===` | `>=→"is at least"`, `===→"is"`, `!==→"is not"`, `<→"is under"`. |
| **`valueOfRight`** | VariantChanged:condition `{value}` | `Variant.right` is `UnionValue\|PageComponent\|CustomCode` — leaks uuid / raw CSS string | UnionValue→displayName ?? value; PageComponent→page name via resolveName; CustomCode→exprSummary. |

These four are not degrades — they are **missing catalog rows**. Without them the area's flagship
templates emit raw diffs on day one.

### 2.2 Raw-value / raw-uuid leaks (defined templates that still leak)

| template | leak | better SHAPE (DRAFT–V-REVIEW) |
|---|---|---|
| `StylePropertyChanged` "set {key} to {value}" | with the key fix landing naively → "set padding-left to 16px" (a CSS diff — forbidden) | `Card, in dark mode: 2px more left padding` via cssPropConcept + dimDelta; no combo → drop the clause, never a `Set:<uuid>` blob; no pairing → "Card: left padding changed" (no direction); no key → coalesce all keyless `_values` writes in the cut into "Card: styling changed (N properties)". |
| `ArtboardChanged:backgroundSet` "→ {color}" | `config.bgColor` is a raw `oklch(...)`/`#rrggbb` string | route through the swatch/hex humanizer the §3 law already mandates: `Set the {componentName} artboard background to {swatch} {hex}`. Reuse the StyleProperty color path, don't hand-format. |
| `TokenAliased` `{targetTokenName}` | the alias target is a uuid in `after`; `decorate` does NOT label after (VERIFIED `operators.ts:114-120`); also legacy `var(--token-{uuid})` string form leaks the var() | deref via valueAsOf+name-ladder (the §4.3.4 machinery); add the legacy-string branch (regex-extract uuid → resolve); unresolved → "now points at another token", never the var() string. |
| `InvokeOperationChanged` `{operationLabel}` | `InvokeOperation.operation` ref in `after`, unlabeled | mark ⚠ref(before/after deref); `{argSlot}` is an ArgSlot **entity** map key → also ⚠entity-key (the string-key fix is insufficient). |
| `WiredEventHandler` `On {event}` | event key is the reparent `tuple[1]` (dropped) or a serialized State; falls back to "On eventHandlers" or leaks `Value:["uuid"]` | once the reparent key is surfaced: strip `on` prefix + lowercase → "On click, …"; param case → deref the State → "On the Card's onSelect callback, …". Never the raw `onClick`/serialized key. |
| `AttrChanged`/`HandlerChanged` `{value}` | record-expr serializes to a `[uuid]` tuple; unlabeled | route `{value}` through exprSummary; when key unavailable AND value is an expr-ref, collapse to "Set an attribute on {label}" — never the tuple. Mark ⚠value in addition to ⚠key. |
| `ComponentMetadataChanged` `{key}` | `metadata` is a `@syncing.record` (Y.Map); inner key discarded (VERIFIED); NO ⚠key marker, and `metadata` omitted from §4.3#1's record list | mark ⚠key; add `metadata` to §4.3#1; degrade to "Set custom metadata on {label}". A value-EDIT is delete+insert keyless — needs the key just to coalesce the pair. |
| `FontChanged:labelsEdited` "labeled {tag} '{label}'" | `featureLabels`/`axisLabels` are **scalar JSON-string** attrs (`'{"ss01":"Alternate a"}'`) — a SECOND key-loss class the doc never names | demote to "Font '{name}': renamed a {feature\|axis} label" (per-key delta unrecoverable from a scalar-JSON set), OR diff parsed old-vs-new JSON in the lens. Flag JSON-string scalars as a distinct key-loss class. |
| `TokenDeleted`/`TokenRenamed` `'{name}'` | 10 of 12 token classes allow `name: string \| null` (VERIFIED on Shadow/Box/Gradient/… ); unnamed → "Deleted gradient token ''" / "'null'" | route null through a noun-phrase: "Deleted an unnamed gradient", "an ad-hoc shadow group" — never empty quotes or "null". |
| `ThemeElementDefaultChanged` "Default text style for {tag}" | `ElementDefault` is designed to grow `surface`/`box` channels (JSDoc), and `{tag}` is the **record key** (lost) | parametrize the channel off the changed field name: "Default {channel} for {tagLabel}"; mark ⚠key (tag). |
| `EffectsScalarChanged`/`LayerChanged` filter-param edits | `FilterLayer.params`/`TransformLayer.params`/`SVGFilterElement.attributes` are map-backed → unpaired + keyless; "blur 8px→12px" impossible for filter params | split by storage: attribute-backed layer fields (ShadowLayer x/y/blur/spread, GradientStop position) keep the felt-delta (they DO pair); map-backed params degrade to "Card: adjusted the {kind} filter" until param-key+pairing land. |
| `ArgSwitchArmsChanged`/`ChoiceOptionsChanged` | null/boolean arm → "arm ''" / "arm 'true'" (bare literal); ChoiceOption has both label AND value | null → "arm for the empty/null case"; boolean → "arm 'true' (boolean case)"; ChoiceOption → "'{label}' (= {value})" when label≠value, fall back to value when label null. |
| `CustomCodeActionEdited` "{code}" | dumps raw `CustomCode._code` JS body | branch on `represents`: `'action'`→structured summary ("Incremented count"/"Toggled dark mode"); null→"Edited the code for step 'X' (N lines)" or ≤40c excerpt via exprSummary. Never the full body. |
| `HandlerInternalsChanged:concurrency` | leaks `ConcurrencyMode` enum ("takeLast") | domain phrasing: takeLast→"cancels the previous run when re-triggered", sequential→"queues overlapping runs", once→"runs at most once", **null→DROP** (sync default). |
| `DataSourceChanged:link-external` "({url})" | `externalLinks` keyed by provider (lost); raw URL leak | mark ⚠key; "Linked {name} to its {providerLabel} request"; degrade to "…an external request" (no raw URL) until the key lands. |
| `CommentEvent:react` | reactions key is `${user_id}:${emoji}` — BOTH halves lost; react add vs remove is insert vs remove | note the lost key is user_id:emoji (both); phrase "A reaction was added/removed"; never claim the emoji or reactor while the key is dropped. |

### 2.3 Conflation rewrites (one template hides distinct intents)

| template | conflation | split (DRAFT–V-REVIEW) |
|---|---|---|
| `DataSourceChanged:relabel` | DSD has FOUR human fields: `name` (JS id), `label` (display), `description`, `category` — all collapsed into "Renamed" | `name`→"Renamed data source {b}→{a}"; `label`→"Relabeled data source {name}: {a}"; `description`→"Edited the description of {name}"; `category`→"Moved data source {name} to {category}". Same split for ValueOperation (name/displayName/description). |
| `TokenValueChanged` examples ("blur 8px→12px", "angle 90°→135°") | attributed to the wrong entity — blur is a ShadowLayer edit, angle is GradientToken.angle, not a StyleToken `values` write | separate by entity: ColorToken/StyleToken base value → "{name}: → {color}" (combo ⚠key); GradientToken scalar geometry → "{name}: angle 90°→135°"; ShadowToken layer edits → owned by LayerChanged (flag the cross-area dedupe — pick the Site-level ShadowToken owner). |
| `PaletteChanged` (one row) | collapses ColorPalette (application) + PaletteFunction (recipe) + PaletteFunctionStep — different blast radius (a shared-recipe edit fans out to every palette) | split `PaletteApplicationChanged` (ColorPalette: created/baseChanged/descriptionEdited) vs `PaletteRecipeChanged` (PaletteFunction + Step: created/stepAdded/stepRenamed/derivationEdited). Legibility of blast radius. |
| `ImportChanged:edit-hostless-manifest` | HostLessPackageInfo has 5 independent members (npmPkg/cssImport/deps/registerCalls/minimumReactVersion) collapsed to "edited the manifest" | per-list subKinds or phrase the specific list: "Hostless {name}: added npm dep {x}" / "bumped min React version". |
| `TokenCreated: scalar\|gradient\|composite` | 9 of 12 token classes collapse into "composite" with no field coverage (violates §0.1) | per-class subKind keyed off `entity.type` (the lift captures it). `tokenNoun(type)` already needs a 12-entry table; mirror it in subKind. Each class gets its own birth-payload MERGE set. |
| `CommentEvent:delete` | folds hide (recoverable) into delete (cascade) | split `CommentEvent:hide` from `:delete`. |
| `StateRemoved` `{kind}` | variant-group kind needs `State.isVariant` reverse-lookup, but the VariantGroup is deleted in the same cut | reconstruct the subjecting VariantGroup via valueAsOf at the detach seq; or (per 1.8) let the Variants area own variant-group removal. |

### 2.4 Burst / continuous-value rewrites

| template | problem | fix |
|---|---|---|
| `ArtboardChanged:resized` | drag-resize = many cuts → flood "801×500, 802×500, …"; must not fire at birth (800×500) | coalesce per §4.2.8 burst window to FINAL size; suppress when frame is FRESH; `{componentName \|\| "untitled"}` (displayName can be null). |
| `TextChanged:set` | assumes RawText; `TextSet.text` is `RawText \| ExprText` — ExprText has no `.text` | discriminate by `isExprText`: RawText→"Set text … to '{excerpt}'"; ExprText→"Bound text of {label} to {exprSummary}". |

---

## 3. NEWLY-COVERED CASES (uncovered entity×field×verb the skeptics found)

These falsify the §0.1 "every entity-class × field × verb has a disposition" claim. Each gets an
explicit disposition here.

### 3.1 The biggest hole — RuleSet birth CSS-seed (Component)

**VERIFIED (`TplMgr.ts:638-661`).** display:flex / flex-direction:column / position:relative
(+ width/height:stretch for page/frame) on the root's fresh RuleSet at component creation.
**Disposition: MERGE** into `ComponentAdded` (the default layout shell) — add the §2.2 rule from 1.1.
Re-baseline the canonical example.

### 3.2 Per-area uncovered cases with dispositions

| entity.field.verb | area | disposition (DRAFT–V-REVIEW) |
|---|---|---|
| `userManagedFonts` add/remove (`@syncing.set<string>`, VERIFIED) | Project/Site, Tokens | **EMIT** "Added web font {family}" / "Removed web font {family}". The value IS the human label (no key-loss, no deref). The baseline's "Currently DROP" silently erases a first-class authoring gesture (Google-font picker, Figma import, templates). |
| `ArenaFrame.targetVariants`/`targetGlobalVariants` edit on existing frame | Arenas | deliberate retarget → `ArtboardChanged:variantTargetChanged` (deref uuids → Variant → comboLabel); **DROP** the resize-driven auto-retarget (`ensureActivatedScreenVariantsForFrameByWidth` plumbing). Discriminator: co-occurs with resize anchor → DROP. |
| `ArenaFrame.name` set/clear on existing frame | Arenas | EMIT `ArtboardChanged:renamed` only when entity ∉ FRESH and after non-empty; empty-string birth name MERGEs. |
| `normalizeMixedArenaFrames` sibling top/left rewrites | Arenas | **DROP** when co-occurring with add/remove/move anchor on a sibling frame; EMIT "Repositioned the {componentName} artboard" only for a standalone top/left edit. (Named in §4.4 prose but no detector — add it.) |
| Arena deletion cascade (removeArena → removeComponent for unnamed FrameComponents) | Arenas/Component | "Deleted canvas {name}" anchor; auto-pruned **unnamed** FrameComponents MERGE; a **named** component deleted with it is a separate `ComponentRemoved` EMIT. |
| Intra-arena frame reorder (Arena.children) | Arenas | **DROP** (canvas position is top/left, not list index) — confirm intentional. |
| `ComponentMetadataChanged` value-EDIT | Component | needs key fix + an edit-pairing rule for record maps (delete+insert keyless, must coalesce — and must NOT misfire as the reorder reconstruction). |
| `CodeComponentMetaChanged: defaultSlotContents / interactionVariantMeta` `{slotKey}` | Component | add both records to §4.3#1; mark templates ⚠key. |
| `SlotParam.allowedRootChildren` add/remove `{childLabel}` | Component | ref in after → add to §4.3#4; deref or render a uuid. |
| `AbstractTplNode.motionAnimations` insert/remove (on EVERY TplNode) | Tpl | MotionChanged is mis-filed under Styling (RuleSet-level); add a Tpl-area `AnimationChanged` anchored on the TplNode, or have MotionChanged explicitly own this Tpl-level list. |
| `TextChanged:inlineNodeWrapped` — NodeMarker + inline TplNode materialize | Tpl | add a §2.2 MERGE: a TplNode referenced by a NodeMarker.tpl in the same cut MERGEs into the wrap event (else spurious NodeAdded for the inline span). |
| `PropSpread` add cascade + exclude/priority | Tpl | PropSpread + `source` expr child MERGE into SpreadChanged:set; `exclude` reads list-insert `after` (string). |
| Same-parent child reorder (sibling reorder) | Tpl | add a "reordered children of {parent}" row gated on same-parent remove+insert, flagged direction-less (or DROP). |
| `RuleSet.ruleRepresentationPreference` (`@syncing.record`) | Styling | **DROP** (studio-only disclosure hint, zero emitted-CSS effect) — add to the §2.3 render-hint DROP set with a note. Falsifies "every field" until listed. |
| BackgroundLayer/MaskLayer geometry edits (attachment/clip/origin/blendMode/mode/composite) | Styling | **recoverable today** (attribute-paired) — add `LayerChanged:edited` arms: "Card: background now repeats" / "mask now uses luminance". Leaving uncovered is a real hole, not a blocked one. |
| SVGFilterLayer / SVGFilterElement subtree | Styling | add a MERGE: SVGFilterLayer materialize folds its SVGFilterElement children → "added a custom SVG filter (N primitives)"; per-primitive attribute edits blocked on param-key. |
| `RuleSet.box`/`textStyle` CLEAR | Styling | `clear {field:box}` with `before`=old uuid → name from before (decorate doesn't resolve before — §4.3#4); "cleared the box recipe (was {name})" or degrade to "removed the box recipe". |
| `QueryInvalidationSelector.invalidateAll` false→true | Behavior/Data | the §3 "Refetch all queries" template has NO producing disposition (the doc itself flags it homeless in §4.2.4). **Give it an EMIT→QueryInvalidationChanged:invalidateAll row** OR move the whole concern to Data and delete the orphan template. A template with no producer fails totality. |
| `EventHandler.declaration` (ArgTuple) | Behavior | MERGE into WiredEventHandler at birth; on edit → "Gave the {event} handler a typed signature (N params)". |
| Signal retarget (`Signal.ref` set, `EventSignal.event` set) | Behavior | add `HandlerInternalsChanged:signalRetargeted` ("reacts to {new} instead of {old}") + signalEvent ("now listens for '{event}'"). |
| `InvokeOperation.args` entry removal | Behavior | add `:argCleared` "Cleared the {argSlotName} argument on {operationName}". |
| ActionStep condition (nameless) | Behavior | use the enclosing ActionIntent.stepName; add a conditionCleared row "Step '{intent}' now always runs". |
| `ExposedSpec.onChange` set/clear | Params | EMIT "'{name}' is now two-way bound to its host" / "no longer". Never the raw callback id. |
| `ArgSlot.description` | Params | "Edited the description of {slotName}". |
| `LabeledSelector.label` / per-selector `defaultStyles` | Params | "'{owner}' selector '{selector}': labeled / set N default props" — attribute to the specific selector (defaultStyles exists at TWO levels). |
| `RefType.callbackRef ∅→false`, `ColorPropType.noDeref ∅→false` | Params | birth defaults that MERGE into the type-add; complete the §2.3.1 DROP enumeration (callbackRef missing) and reconcile with §2.2.3. |
| `ProviderSource.externalKeys` edit | Params | "Remapped how '{owner}' reads the {provider} flag" (key-agnostic; inner keys blocked). |
| `Variant.right` ref in after | Variants | add to §4.3#4 (UnionValue/PageComponent in after, unlabeled). |
| `ImageAsset.width/height/aspectRatio/origin` later edit | Tokens | **DROP** (machine-derived) or "Re-cropped asset {name}"; currently falls through (no AssetChanged subKind). |
| `TextStyleCell` / `PaletteFunctionStep.derivations` nested combo-keyed values | Tokens | doubly key-blocked (combo + css-prop); add TextStyleToken-recipe-edit + PaletteRecipeChanged:derivationEdited rows; attribute via ancestorChain (TextStyleCell→TextStyleToken). |
| `ColorPalette.description ∅→""`, `PaletteFunction.description ∅→""`, `PageMeta.description ∅→""` | Tokens/Component | **VERIFIED** (`= ""` defaults). Add `∅→""` empty-string births to the §2.3.1 DROP set — they DO reach the lens (not null-elided) and spuriously EMIT a description-edit on every creation. |
| `Split.targetEvents`, `Split.status→stopped/new`, `Split.splitType=null` | Data | "Experiment {name} now tracks event {x}"; "Stopped experiment {name}"; on add fall back "Created split {name}" when splitType null. |
| `Definition.previewValue` | Data | "{name} preview value → {value}" (mirror StateDefaultChanged's default/preview split — currently dropped). |
| `NpmPackage.jsIdentifier` rename, `providerConfig` edit | Data | "Renamed the import handle for {name}"; "Configured {name} provider ({paramSummary})" — §4.4 claims provider.config coverage but no §3 row exists (contradiction). |
| `TextChanged:cleared` (TextSet entry removed) | Tpl | "Cleared the text of {label}" — clear-text has no inverse template. |

### 3.3 Top-level-delete EMIT rows (the critic's confirmed gap)

**VERIFIED** all entities exist. The forward `remove*` ops exist (`removeDataSource`,
`removeOperation`, `removeQuery`, `removeNpmPackage`, `removeCustomFunction`, `removeProjectVariable`,
`removeSplit`) but the backward EMIT rows are missing. Add a `*Removed` row for each, label via
`valueAsOf` point-in-time, mirroring the `*.add` rows 1:1: DataSourceDefinition, ValueOperation,
ComponentDataQuery, NpmPackage, CustomFunction, Definition, Split.

---

## 4. CROSS-AREA + MISSING-RULE RESOLUTIONS (from the critic)

| issue | resolution |
|---|---|
| **VariantsCombination double-emission** | Owner = render-tree / node-activation (parent is `ArgsSet`, not a variants entity). **DROP it in the Variants area**, mirroring how `Site.components` insert is owned by the Component area and DROPped by the Tpl area (§2.3.3). Until a dedupe rule is named in BOTH docs it is a latent double-count. |
| **swapToken N-usage explosion** | `aliasToken`/`swapToken` rewrites the token ENTITY and re-points every usage → the lens would naively read N independent StylePropertyChanged across many targets. Add a **swap-recognizer**: one cut, same target-token across N nodes → one `TokenAliased`/swap event. (Lost-intent via over-emission.) |
| **action-level invalidateAll:true** | No EMIT home (DefinitionInvalidationTarget reachable from 3 parents). Decide Data-vs-Behavior owner and give `invalidateAll false→true` an explicit EMIT (3.2). (Lost-intent via fall-through.) |
| **promoteVariantAxis reparent → spurious NodeMoved** | resolved by 1.9 (entity-typed reparent guard ahead of NodeMoved). |
| **Transaction-grouping contract** | KNOWN-violated both ways: macros = one cut/many ops (importOpenApi = N DSDs — correct, it's an anchor); drags/typing = many cuts/one gesture (burst, §4.2.8 — threshold still unset). Stop asserting it as a confirmed invariant; state the over-merge (macros, intended) and under-merge (drags, needs burst window) explicitly. |
| **Entity-keyed-map second resolver** | distinct from the key-surfacing fix: `resolveName(mapKeyUuid, atSeq)` applied to `change.key` when the container is entity-keyed (ArgsSet.args=State, slots=SlotParam, eventHandlers=State, InvokeOperation.args=ArgSlot). Build it lens-side. |
| **Refs in before/after auto-labeling** | **VERIFIED** `decorate` only labels entity/from/to. The lens must run a deref+displayNameLadder pass over before/after for the enumerated ref fields (subject, target, extends, operation, box/textStyle, Variant.right, defaultExpr, CrossFieldRule.slots, SlotParam.allowedRootChildren). Lens-side archive-read by uuid+seq. Currently produces raw-uuid leaks in TokenAliased / subjectRebound / chain — templates ASSUME resolved names. |
| **Salience-allowlist for metadata / machine-stamps** | `ComponentBase.metadata` (raw Record) + importer/cacheNpmPackageTypes stamps will flood the human log. Change from "EMIT-all until then" to a **lens-owned DROP allowlist of machine-stamp key prefixes**. Currently a DB-diff leak waiting to happen. |
| **§4.3#1 phantom fields** | `matchSlots` and `_values` cited as Params-area lost keys are wrong: `matchSlots` does NOT exist (it's `ArgSwitch.matches`, a child.list of ArgMatch ENTITIES); `_values` is a Styling field, not Params. The genuine Params primitive-record keys are `ReturnRecord.stateWiring`, `ProviderSource.externalKeys`, `ClassNamePropType.defaultStyles`/`LabeledSelector.defaultStyles`. Drop the phantoms. |
| **Entity-record vs primitive-record key** | §4.3#1 conflates two cases: (a) **primitive** records (`@syncing.record`: stateWiring/externalKeys/defaultStyles) — key genuinely lost, needs `PlexusChange.key`; (b) **entity** records (`@syncing.child.record`: ArgRecord.fields/ReturnRecord.fields) — the child materializes as an XmlElement carrying its key via `parentFieldKey`/`displayNameLadder`, **recoverable today, no core change**. Move ReturnRecord.fields/ArgRecord.fields out of the blocking bucket; only stateWiring stays ⚠key. |

---

## 5. UPDATED COVERAGE REPORT

### 5.1 Now solid (verified against source, survives skepticism)

- **The two-layer architecture** (core CRDT-blind / lens domain-specific) — unchanged, correct.
- **The disposition philosophy** (EMIT-anchor / MERGE-children / DROP-defaults) — the right shape;
  every kill is an *addition or correction* to the rule set, never a rejection of the frame.
- **FRESH-by-cut as the birth discriminator** — VERIFIED load-bearing. But the "before-presence ≡
  FRESH" equivalence is **killed** (1.4 + the :hover double-name path): FRESH is the ONLY safe
  discriminator; within-cut re-sets of a fresh entity collapse the LAST value into the *Added payload.
- **Genesis-namespace DROP** — VERIFIED real (`isGenesisClientId` exported; genesis entities DO enter
  the stream via applyUpdate, so the DROP is necessary; the pseudo VariantGroup+Variant get REGULAR
  clientIds and survive). One caveat: verify the bootstrap `addDummyArena` and PaletteToken
  virtual-genesis actually land in the genesis namespace — the doc conflates "derived" with
  "genesis-namespace".
- **Removal + subtree cascade** for true detach/remove verbs — sound (but comment delete is a SET, 1.6).
- **Attribute-backed felt-deltas** (ShadowLayer blur, GradientStop position, EffectsToken opacity,
  scalar token geometry) — these DO pair in the lift; the felt-delta templates are correct for them.

### 5.2 Still open / blocked (honest)

**Blocking core-lift dependencies (the lens cannot work around):**
1. Record/map entries lift unpaired → no value-edit detection, no felt-delta on records. **Fix in
   core** (pair Y.Map insert+delete by key).
2. Map/record entry key discarded — three stacked shapes (string / entity-Set / entity). **Fix in
   core** (structured key) + **lens** (decorate over map keys, second resolver pass).
3. No reorder verb / no index → direction-less, false-positive-prone. **Fix in core** ({from,to}).
4. Refs in before/after unlabeled → raw-uuid leaks. **Fix in lens** (deref+ladder pass).
5. reparent/detach drop tuple[1] (child-list key) → event identity for WiredEventHandler. **Fix in core.**

**Product decisions still V's call:** burst threshold; ProjectCreated (out-of-model vs t0-snapshot);
salience allowlist for metadata/machine-stamps; `represents`-tag EMIT-vs-DROP; the data-flow
invalidation owner (Data vs Behavior).

**Areas by health (after hardening):**
- Tpl, Behavior, Styling, Tokens: **were SHAKY/BROKEN as drawn**, now have the additions/degrades
  needed but **gated on the core-lift fixes** (1, 2, 3, 5). Until those land, demote felt-deltas to
  explicit degrades and stop asserting "never a DB diff" for record-backed fields.
- Arenas: was the most broken sub-area; fixed by FRESH-by-ancestry (1.4), multi-anchor precedence
  (1.8), entity-typed reparent (1.9), and dropping `ArenaChanged:reordered` (1.10).
- Project/Site: stop claiming totality for unreachable events (1.11).
- Params, Variants, Data, Collaboration: **SHAKY**, fixed by the new rows + the field→subKind tables
  + the friendlyType/subjectPhrase/operatorPhrase helpers + comment-set routing (1.6).

### 5.3 Corrected survey count (the wave-2 165-NEW figure is inflated)

**The survey undercounted the studio mutation surface and over-counted NEW.** It tallied only
TplMgr+SiteOps (~71). Verified-larger reality:
- TplMgr ~50 public methods; SiteOps ~39 → ~89 already, > the claimed 71.
- Uncounted: VariantOps (~20: createVariantGroup/createVariant/renameVariant/moveVariant/
  setAccessType/setDynamicExpr…), insertion-ops (~33), the `providers/core/operations/` directory
  (~24 clearly-mutation fns: addComponentState, updateStateAccessType, addSlotParam,
  removeComponentParam, mkGlobalVariantSplit, changeTokenUsage…), and **studioCtx-direct** methods
  (changePagePath, addNewMixedArenaFrame live on studioCtx, not siteOps).

**Corrected sense:** existing studio mutation surface is realistically **~120-150 distinct methods**,
not ~71. Spot-checks REFUTE specific "ALL NEW" verdicts: `splits.ts` already exports
mkGlobalVariantSplit + removeVariantGroupFromSplits (doc said "ALL of Splits NEW"); `states.ts` has
addComponentState + updateStateAccessType; `components.ts` has addSlotParam + removeComponentParam.

**Corrected NEW figure: ~110-130, not 165** (~20-30% overstatement of studio-side absence). Of the
"NEW" ops, ~25-40 already have a (coarse/un-faceted) studio home the survey missed — "ALIGNED-but-
coarse" rather than truly absent. The MCP side (~82 actions / 13 clusters) was **accurately** counted.
The "first consolidated facade" reveal survives for the MCP/agent gap and for Operations / Imports /
Project-Variables (which genuinely lack named methods), but not at the 165 magnitude.

### 5.4 Sharpened V-decisions carried forward

- **`locked`** is `boolean|null`, no `=false` initializer → real birth is `∅→null` (emits nothing).
  The canonical-16 "locked ∅→false" is toy-shaped, wrong for the real path. (VERIFIED both ways.)
- **`standalone`** IS `= false` → variant-add emits a real `∅→false` the FRESH rule must MERGE
  (discriminator load-bearing here).
- **`RandomSplitSlice.prob`** is a 0-100 percentage (splits seed `prob:50`), not a 0-1 fraction.
- **`condition`** is a phantom — it's `(operator, right)`. (VERIFIED `Variant.ts`.)
- **`metadata`** is a raw `Record<string,string>` → the salience-DROP risk is real; move off EMIT-all.
- **Empty-string defaults** (`description: string = ""` on PageMeta/ColorPalette/PaletteFunction) DO
  reach the lens and must join the `∅→default` DROP set. (VERIFIED.)
- **FRESH, not before-presence, is the birth gate.** "after === default" is unsound for any entity
  whose constructor writes non-defaults (ArenaFrame.viewMode). (VERIFIED `FrameConfig.ts`.)

---

## 6. Bottom line

The design is **architecturally sound and the disposition frame is correct** — but the baseline
**oversold totality and shipped its proof fabricated**. The honest status: a strong skeleton that
needs (a) the canonical example re-derived from the real `TplMgr` path, (b) the FRESH-by-ancestry
generalization, (c) ~35 newly-covered rows + field→subKind tables, (d) ~15 humanization rewrites
(four of them missing-helper rows, not degrades), and — the gating dependency — **five core-lift
widenings** (pair record entries, structured key + decorate-over-keys, reorder verb, ref-deref,
reparent tuple[1]). Until those five land, every record-backed felt-delta template must be demoted
to an explicit degrade, because fed real input today this design would emit either keyless
"something changed" noise or raw-uuid/raw-value/raw-JSON leaks across Styling, Tokens, Behavior, and
Collaboration. Fixable, not foundational — but not shippable as drawn.
