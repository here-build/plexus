# The Operations Layer — the FORWARD/prospective intent surface of here.build

> Status: design, synthesized from 7 per-area totalic op-derivations + 3 existing-surface surveys
> (MCP/arrival, siteOps/TplMgr) + 2 core widenings (2026-06-24).
> The closed, designed set of "what one can DO to a project."

---

## 0. The layering invariant (read this first)

This document defines the **FORWARD / prospective** surface: an operation is a deterministic
**function** `operation → PlexusChange[]` (the changes it produces). It is **imperative** and
**total**: every meaningful project mutation is expressible by exactly one operation, the set is
**closed** (designed, not open-ended), **orthogonal** (no two operations overlap), and **minimal**.

```
                    ┌─────────────────────────────────────────────┐
   FORWARD          │  OPERATIONS LAYER  (this doc)                │
   prospective      │  operation(typed params) → PlexusChange[]    │   total · closed · orthogonal
   imperative       │  "addComponent('Card')"  ─────────────┐      │
                    └───────────────────────────────────────│──────┘
                                                             ▼
                                            core: PlexusChange[]  (domain-agnostic CRDT diff)
                                                             │
                    ┌────────────────────────────────────────│─────┐
   BACKWARD         │  DESCRIBING LAYER  (intent-lens-design) │     │
   retrospective    │  PlexusChange[] → IntentEvent[]   ◀─────┘     │   lossy · partial
   declarative      │  "Added component 'Card'"                     │
                    └──────────────────────────────────────────────┘
```

**★ THE INVARIANT — intents ≠ descriptions, kept SEPARATE.**

- The **operations layer** (here) is the closed designed set of forward verbs. It is **total**:
  every model mutation maps to one operation. It is the *prospective* surface — what an actor
  (a human, or an agent through MCP) can ask the studio to do.
- The **describing layer** (wave 1, `intent-lens-design.md`) is the *retrospective* recognizer:
  `PlexusChange[] → IntentEvent[]`. It is **lossy and partial** — many logged changes have **no
  operation behind them** (CRDT merges from a concurrent peer, cycle-repair, ownership-rejection
  cleanup, raw importer writes, machine stamps). The describing layer **USES** this operations
  vocabulary as a *recognizer* (it pattern-matches a `RuleSet.viewMode` set-cluster and says "this
  looks like `setArtboardViewMode`"), but it does **NOT depend on it** and never fails when no
  operation produced the change.

The dependency arrow points **one way**: the describing layer references operation names as labels;
the operations layer knows nothing of the lens. A change with no recognizing operation is still a
valid `IntentEvent` (a generic "edited X") — the lens degrades, the operation set does not grow.

**Why this matters (the cardinal failure it averts):** here.build already has forward mutation
surfaces — siteOps/TplMgr (studio gestures) and the MCP `projectEditingTool` clusters (agent
verbs). The honest job is **not** to mint a third parallel layer (the tech-debt trap the whole
resource discipline warns against). It is to **DERIVE** the total vocabulary from the model + the
wave-1 intent events, then **RECONCILE** it against what exists. Every operation below carries an
explicit reconciliation verdict: ALIGNED, SUPERSET, or NEW.

---

## 1. The operation vocabulary

One coherent, orthogonal, minimal set, grouped by area. Each entry: **name** · **typed params** ·
**effect** (the deterministic `PlexusChange[]` it produces) · **inverse**. Cross-area overlaps are
deduped at the end of each group; genuinely-cross-area operations (e.g. `editLifecyclePredicateClause`,
`setQueryInvalidation`, `swapToken`) are placed in their single owning area and flagged.

**Conventions.**
- `variants: VariantCombo` is the ambient styling/aspect coordinate — NOT an operation. Every
  aspect/style op carries it; there is no "set variant clause" verb (the combo is the address, not
  a mutation). This mirrors how the MCP threads `ctx.variants` through every handler.
- `Ref<T>` denotes an entity reference resolved by uuid.
- An op whose params carry a map/record `key` (`attribute`, `prop`, `flag`, `role`, …) sidesteps the
  describing-layer's W1 key-loss gap **on the forward side** — the key is an explicit param. The gap
  is purely a *backward* recognition problem (see §4).

### 1.1 Project / Site / Arenas (32 ops)

| op | params | effect (→ PlexusChange[]) | inverse |
|---|---|---|---|
| `renameProject` | `name: string` | set `ProjectPackage.name` X→Y | `renameProject(prev)` |
| `createProject` | `name: string` | materialize `ProjectPackage` + child `Site` + genesis bootstrap (EMIT anchor = package materialize + name; rest MERGE/genesis-DROP) | none (deletion is a platform op) |
| `addDependency` | `projectId: ProjectId, yjsState: Uint8Array` | insert read-only `ProjectPackage` snapshot into `dependencies[projectId]` + set `dependencyVersion[projectId]` | `removeDependency(projectId)` |
| `removeDependency` | `projectId: ProjectId` | remove `dependencies[projectId]` + version key; cascades auto-unbind of dep-referencing `defaultComponents`/`pageWrapper` (DROP) | `addDependency(projectId, yjsState)` |
| `upgradeDependency` | `projectId: ProjectId, version: string` | replace `dependencies[projectId]` snapshot + set version before→after | `upgradeDependency(projectId, prev)` |
| `setDiagnosticsRuleset` | `rulesetId: string, enabled: boolean` | insert/remove key in `Site.rulesetEnabled` | restore prev/absent |
| `setDiagnosticsRuleEnabled` | `ruleId: string, enabled: boolean` | insert/remove key in `Site.ruleEnabledOverrides` | restore prev/absent |
| `setDiagnosticsRuleBucket` | `ruleId: string, bucket: Bucket` | insert/remove key in `Site.ruleBucketOverrides` | restore prev/absent |
| `setSiteFlag` | `key: string, value: string\|boolean\|number` | insert/update key in `Site.flags` | `setSiteFlag(key, prev)` / clear |
| `bindDefaultComponentRole` | `role: string, component: Ref<Component>` | set `Site.defaultComponents[role]` | `unbindDefaultComponentRole(role)` |
| `unbindDefaultComponentRole` | `role: string` | delete `Site.defaultComponents[role]` (also auto-fires on component delete, DROP) | rebind |
| `setPageWrapper` | `component: Ref<Component>\|null` | set `Site.pageWrapper` | `setPageWrapper(prev)` |
| `addArena` | `name?: string` | materialize `Arena` + push `Site.arenas` (EMIT anchor; insert MERGE; empty children DROP) | `removeArena(arena)` |
| `removeArena` | `arena: Ref<Arena>` | remove from `Site.arenas` + detach `ArenaFrame[]` subtree + remove owned unnamed FrameComponents | none clean |
| `renameArena` | `arena: Ref<Arena>, name: string` | set `Arena.name` (uniqueName-deduped) | `renameArena(arena, prev)` |
| `reorderArena` | `arena: Ref<Arena>, toIndex: number` | move within `Site.arenas` (→ **W2 `reorder` verb**) | `reorderArena(arena, fromIndex)` |
| `addArtboard` | `arena, component, name, viewMode?, width?, height?, insertPt` | materialize `ArenaFrame` + `FrameConfig` + container `TplComponent` + auto-target screen variants + normalize siblings (EMIT anchor; config/container/insert MERGE; normalize DROP) | `removeArtboard(arena, frame)` |
| `addArtboardWithVariants` | `…addArtboard + targetVariants, targetGlobalVariants` | as `addArtboard` with explicit variant-combo seeds (payload field, not a separate op) | `removeArtboard(arena, frame)` |
| `removeArtboard` | `arena, frame, pruneUnnamedComponent?` | remove `ArenaFrame` from children + detach config/container + normalize + optional FrameComponent prune | `addArtboard` (clean if not pruned) |
| `moveArtboardToArena` | `fromArena, frame, toArena` | reparent `ArenaFrame` (from PRESENT → genuine move) | `moveArtboardToArena(toArena, frame, fromArena)` |
| `repositionArtboard` | `frame, left: number, top: number` | set `FrameConfig.left`+`.top` (burst-coalesced for drags) | restore prev |
| `resizeArtboard` | `frame, width: number, height: number` | set `FrameConfig.width`+`.height` (may auto-toggle screen variant, MERGE) | restore prev |
| `setArtboardViewMode` | `frame, viewMode: 'stretch'\|'centered'\|null` | set `FrameConfig.viewMode` | restore prev |
| `setArtboardBackground` | `frame, bgColor: string\|null` | set `FrameConfig.bgColor` (editor chrome only, NOT emitted) | restore prev |
| `renameArtboard` | `frame, name: string` | set `ArenaFrame.name` (distinct from component rename) | restore prev |
| `setArtboardVariantTarget` | `frame, targetVariants, targetGlobalVariants` | set `ArenaFrame.targetVariants`+`.targetGlobalVariants`; clear-both = `clearFrameComboSettings` | restore prev |
| `setPageRoute` | `page: Ref<PageComponent>, path: string` | set `PageMeta.path` (sanitized/uniqued) + sync `PageMeta.params` (delete stale, seed new `:param`) | `setPageRoute(page, prev)` (params re-sync) |
| `setPageQueryParam` | `page, key: string, value: string\|null` | insert/update/remove key in `PageMeta.query` | restore prev/absent |
| `setPageSeo` | `page, field: 'title'\|'description'\|'canonical'\|'openGraphImage', value` | set one `PageMeta` SEO scalar | restore prev |

> **Dedup note.** The five `setPageSeo*` and `setPageRoute`/`setPageQueryParam` ops mutate `PageMeta`
> (a `PageComponent` child) but are the *site routing/SEO surface*. They are unified here with the
> Component-lifecycle area's identical `setPageRoute`/`setPageSeo`/`setPageQueryParam` — **one op,
> filed under Component lifecycle (§1.2) as the canonical home** to avoid double-emission; this area
> references them. (The single-field `setPageSeo*` variants from the two derivations collapse to one
> `setPageSeo(field, value)` discriminated op.)

### 1.2 Component lifecycle (incl. PageMeta, SlotParam, CodeComponentMeta) (19 ops)

| op | params | effect | inverse |
|---|---|---|---|
| `addComponent` | `type: 'plain'\|'page'\|'frame', name, path?, styles?` | materialize one `ComponentBase` subtype + root `TplTag` shell + seed root RuleSet + (page) `PageMeta` + inject pageWrapper. THE 16-change cascade the lens collapses. | `removeComponent` |
| `registerCodeComponent` | `import: ImportSpec, name, isContext, isHostLess, isAttachment, providesData, hasRef, isRepeatable` | materialize `CodeComponent` + `CodeComponentMetaDef` + (context) push `globalContexts` | `removeComponent` |
| `duplicateComponent` | `component, name?` | deep-clone incl. variants/groups (+ page `PageMeta` w/ fresh path) | `removeComponent` |
| `removeComponent` | `component, force?` | detach from `Site.components` + cascade (frames, role-unbind, PageHref rewrite, type-instance/query refs) | `addComponent` (NOT clean) |
| `renameComponent` | `component, name: string` | set `ComponentBase.name` (collision-deduped) | restore prev |
| `setComponentFlag` | `component, flag: 'hiddenFromContentEditor'\|'exportTier'\|'alwaysAutoName'\|'trapsFocus', value` | set one scalar flag | restore prev |
| `setComponentMetadata` | `component, key: string, value: string\|null` | insert/update/remove `ComponentBase.metadata[key]` | restore prev |
| `setPageRoute` | `page, path: string` | (canonical home) set `PageMeta.path` + re-derive `PageMeta.params` | restore prev |
| `setPageSeo` | `page, field: 'title'\|'description'\|'canonical'\|'openGraphImage', value: string\|ImageAsset\|null` | set one `PageMeta` SEO scalar | restore prev |
| `setPageQueryParam` | `page, key: string, value: string\|null` | insert/update/remove `PageMeta.query[key]` | restore prev |
| `addSlot` | `component, name?, position?, target?` | create `SlotParam` + matching `TplSlot` placeholder + push `Component.slots` + insert placeholder | `removeSlot` |
| `removeSlot` | `component, slot: Ref<SlotParam>` | detach `TplSlot` + remove `SlotParam` | `addSlot` (not perfectly clean) |
| `renameSlot` | `component, slot, name: string` | set `SlotParam.name` (uniquified in tpl+param namespace) | restore prev |
| `setSlotMetadata` | `slot, field: 'displayName'\|'description'\|'about'\|'isMainContentSlot'\|'isRepeated'\|'propEffect', value` | set one `SlotParam` scalar | restore prev |
| `setSlotAllowedChildren` | `slot, components: Set<Ref<Component>>` | replace `SlotParam.allowedRootChildren` | restore prev |
| `setSlotCallback` | `slot, callback: FunctionType\|null` | set `SlotParam.callback` (toggles content↔render-prop slot) | restore prev |
| `setComponentTemplateInfo` | `component, templateName, projectId, componentId (each \|null)` | materialize/detach `ComponentBase.templateInfo` | restore prev |
| `setFigmaMapping` | `component, figmaComponentName: string, remove?` | add/edit/remove `FigmaComponentMapping` in `figmaMappings` | restore prev |
| `setCodeComponentMeta` | `component: Ref<CodeComponent>, field, value` | set one `CodeComponentMetaDef` scalar (display/section/className/ref/capability booleans) | restore prev |
| `setCodeComponentSubMeta` | `component, kind: 'helper'\|'interactionVariant'\|'defaultSlotContent'\|'defaultStyle', key?, value` | materialize/detach one CCMD child sub-entity | restore prev |

### 1.3 Tpl tree structure + per-node aspects (22 ops)

Structure ops change parent/children topology; aspect ops change combo-keyed aspect maps. Kept
orthogonal — a single "edit node" verb would conflate them.

| op | params | effect | inverse |
|---|---|---|---|
| `add-node` | `node: TplNodeRef, position, target` | materialize/adopt + `insertAtPosition` (splice into children / route to `children` slot) | `remove-node` |
| `remove-node` | `node` | detach from parent's children (cascades owned subtree) | `add-node` (clean iff retained) |
| `move-node` | `node, position, target` | reparent EXISTING node (cycle-guarded); the `reparent` with `from` PRESENT | `move-node(prevParent, prevIndex)` |
| `insert-children` | `parent, position, children: TplNodeRef[]` | batch reparent N existing nodes, order-preserving | N× `move-node` |
| `clone-node` | `node, position, target` | deep-clone (fresh uuids) + insert | `remove-node(clone)` |
| `wrap-node` | `wrapper, nodes: TplNodeRef[]` | insert wrapper + reparent nodes into it + transfer PLACEMENT_PROPS per combo | `unwrap-node` |
| `unwrap-node` | `container` | promote children into container's position + remove container | `wrap-node` |
| `replace-node` | `newNode, nodeToReplace` | insert new + migrate children + detach old | `replace-node` (clean iff retained) |
| `rename-node` | `node: TplTag\|TplComponent, name: string\|null` | set node `name` (de-duped) | restore prev |
| `retag-node` | `node: TplTag, tag: string` | set `TplTag.tag` (validated against `allowedTags`) | restore prev |
| `set-semantic-type` | `node: TplTag, semanticType: 'text'\|'image'\|null` | set `TplTag.type` (drives editor + allowedTags) | restore prev |
| `set-locked` | `node, locked: boolean\|null` | set `AbstractTplNode.locked` (editor affordance) | restore prev |
| `set-text` | `node: TplTag, text: string, variants` | write `RawText` into `TextSet` at combo + force `type=Text` | `clear-text` (gap — no verb) |
| `bind-text` | `node: TplTag, expr: string, variants` | write `ExprText(CustomCode)` into `TextSet` + force `type=Text` | `set-text`/`clear-text` |
| `set-attribute` | `node: TplTag, attribute: string, value, variants` | set `AttributesSet.attrs[attribute]` at combo (static or expr) | `remove-attribute` |
| `remove-attribute` | `node, attribute, variants` | delete `attrs[attribute]` at combo | `set-attribute(prev)` |
| `set-arg` | `node: TplComponent, prop: string, value, variants` | set override in `ArgsSet.args[State]` at combo | `clear-arg` |
| `clear-arg` | `node, prop, variants` | remove prop override (→ default) | `set-arg(prev)` |
| `set-repeater` | `node, collection: string, itemVar?, indexVar?` | set `node.dataRep = Rep{element, index, collection}` (NOT variant-aware) | `remove-repeater` |
| `remove-repeater` | `node` | `node.dataRep = null` (detach Rep subtree) | `set-repeater(prev)` |
| `set-prop-spread` | `node: TplTag\|TplComponent, source, exclude[], priority` | add/edit `PropSpread` in `propSpreads` | `remove-prop-spread` |
| `remove-prop-spread` | `node, spread: Ref<PropSpread>` | remove from `propSpreads` | `set-prop-spread(prev)` |

> Dedup: `set-visibility` (the MCP visibility-repeater cluster) is `set-style(display)` + a
> conditional-CustomCode + variant-group — it composes existing ops; not a separate primitive here.
> `add-prop-spread`/`edit-prop-spread`/`remove-prop-spread` from the derivation collapse to
> `set-prop-spread` (add/edit) + `remove-prop-spread`.

### 1.4 Styling / RuleSet / layers (16 ops)

Every styling write addresses `(TplNode, VariantCombo) → RuleSet`. The `--studio-*`/`--ir-*` intent
markers are ordinary `RuleSet._values` keys → `setStyleProperty` is ONE op even though the lens
splits it into SizingModeChanged / DisplayVisibilityChanged / StyleMarkerChanged / StyleExpressionBound.

| op | params | effect | inverse |
|---|---|---|---|
| `setStyleProperty` | `target, variants, property: StudioCSSProperty\|marker, value: string\|CustomCode` | write one `RuleSet` entry at combo (marker fan-out applies implied props) | `clearStyleProperty` |
| `setStyleProperties` | `target, variants, styles: Record<prop,value>` | batch `assignStyles` (shorthand-expanded) | restore prev snapshot |
| `clearStyleProperty` | `target, variants, property` | delete from `RuleSet` (marker clear → clears implied props) | `setStyleProperty(prev)` |
| `clearVariantRuleSet` | `target, variants` | drop the whole per-combo RuleSet override | re-author (snapshot) |
| `addLayer` | `target, variants, kind: LayerKind, spec, position?` | push/unshift layer onto per-kind list | `removeLayer` |
| `removeLayer` | `target, variants, kind, layerUuid` | remove from per-kind list + drop visibility entry | `addLayer` (+ reorder) |
| `reorderLayer` | `target, variants, kind, layerUuid, toIndex` | move within per-kind list (→ **W2 reorder**) | `reorderLayer(orig)` |
| `editLayerField` | `target, variants, kind, layerUuid, field, value` | edit one field on an existing layer IN PLACE (base combo) | restore prev |
| `setLayerOverride` | `target, variants(non-base), layerFieldKey, value` | per-variant override of one layer field (`layerOverrides`) | `clearLayerOverride` |
| `clearLayerOverride` | `target, variants, layerFieldKey` | remove per-variant override | `setLayerOverride(prev)` |
| `setLayerVisibility` | `target, variants, kind, layerUuid, visible: boolean` | toggle layer per variant (`layerVisibility`) | self-paired |
| `attachStylePack` | `target, variants, pack: SurfaceToken\|EffectsToken` | add ref to `surface.extends`/`effects.extends` | `detachStylePack` |
| `detachStylePack` | `target, variants, pack` | remove pack ref | `attachStylePack` |
| `setEffectsScalar` | `target, variants, scalar: 'opacity'\|'mix-blend-mode', value` | set on `RuleSet.effects` (EffectsToken — NOT `_values`) | restore prev |
| `setBoxRecipe` | `target, variants, box: BoxToken\|null` | set `RuleSet.box` ref | restore prev |
| `setTextStyle` | `target, variants, textStyle: TextStyleToken\|null` | set `RuleSet.textStyle` ref | restore prev |
| `setDefaultTransition` | `target, variants, spec: {duration,easing?,delay?}\|null` | set/clear `RuleSet.defaultTransition` child | restore prev |
| `setPropertyTransitions` | `target, variants, property, spec: boolean\|TransitionSpec` | add/update/remove `transitioningProperties[property]` | restore prev |
| `setKeyframeAnimation` | `target, variants, keyframes, timing` | add `MotionKeyframes`+`MotionAnimationRef`→`RuleSet.motions` | `removeKeyframeAnimation` |
| `removeKeyframeAnimation` | `target, variants, keyframesUuid` | remove motions entry (gc MotionAnimation) | `setKeyframeAnimation(prev)` |

> Dedup / boundary: `setCustomSelector` (SelectorRuleSet.selector) is parented to a `StyleExpr`, not
> the variant rs-map → it belongs to the **Behavior/Expression** area (`editExpression` style case),
> NOT here. `setBoxCoupling` (ruleRepresentationPreference) is studio-presentation-only (no emitted
> CSS) → **DROP-class, excluded from the closed set** (not a project intent). Gradient-stop edits ride
> `editLayerField` when embedded, but `GradientToken` is also a Tokens-area entity → cross-area dedupe
> (see §3). The above 20 entries collapse to the 16 unique families after folding the two
> motion ops + the two transition ops into their pairs.

### 1.5 Tokens & Theme (22 ops)

Token-ENTITY lifecycle only. The *usage* of a token on a node (BoxRecipeChanged, attach/detach) is
the Styling area. `swapToken` is the one bleed (usage-rewrite) — flagged.

| op | params | effect | inverse |
|---|---|---|---|
| `createToken` | `kind, name?, scalarType?, baseValue?, gradientType?, valueKind?, cluster?, tags?` | materialize token onto matching `Site.*Tokens` list + seed base | `deleteToken` |
| `renameToken` | `token, name: string\|null` | set token `name` | restore prev |
| `deleteToken` | `tokens: Ref<Token>[]` | remove from owning list (StyleToken path rewrites usages first) | `createToken` (NOT clean) |
| `setTokenValue` | `token, combo: Set<VariantString>\|null, value: string\|CustomCode` | write one cell of combo-keyed `values` (or composite scalar field) | `setTokenValue(prev)` / `clearTokenValue` |
| `clearTokenValue` | `token, combo` | delete non-base combo cell | `setTokenValue` |
| `aliasToken` | `token, combo, target: Ref<StyleToken>` | set cell to `CustomCode.pointer(target)` | `setTokenValue(prev)` |
| `setTokenComposition` | `token: CompositeToken, extends: Ref<CompositeToken>[]` | write same-kind `extends` chain | restore prev |
| `setTokenExportTier` | `token, tier: 'stable'\|'beta'\|null` | set `exportTier` | restore prev |
| `setTokenClassification` | `token: StyleToken, valueKind?, cluster?, tags?` | write intent fields | restore prev |
| `createPalette` | `name, function: Ref<PaletteFunction>, base, description?` | materialize `ColorPalette` onto `Site.palettes` (derived `PaletteToken`s DROP) | `deletePalette` |
| `setPaletteBase` | `palette, base` | set `ColorPalette.base` (re-derives tokens, DROP) | restore prev |
| `editPaletteDescription` | `palette, description` | set `ColorPalette.description` | restore prev |
| `createPaletteFunction` | `name, represents?, description?` | materialize `PaletteFunction` onto `Site.paletteFunctions` | `deletePaletteFunction` |
| `editPaletteFunctionStep` | `function, op: 'add'\|'remove'\|'rename'\|'setDerivation', step, combo?, derivation?` | mutate `steps` list + `derivations` map | complementary op |
| `uploadFont` | `name, originalFilename?, files: FontFile[], features?` | materialize `CustomFont` + N face children onto `Site.customFonts` | `removeFont` |
| `editFontFaces` | `font, op: 'addFace'\|'removeFace', file` | insert/remove `CustomFont.files` | complementary |
| `setFontLabel` | `font, kind: 'feature'\|'axis', tag, label: string\|null` | update JSON labels (UI-only) | restore prev |
| `createAsset` | `name, dataUri, type?, origin?, width?, height?, aspectRatio?, keywords?` | materialize `ImageAsset` onto `Site.imageAssets` | `deleteAsset` |
| `editAsset` | `asset, name?, type?, keywords?` | edit name/type/keywords | restore prev |
| `deleteAsset` | `assets: Ref<ImageAsset>[]` | remove after stripping bg/mask usages | `createAsset` (NOT clean) |
| `setElementDefault` | `tag: string, channel: 'textStyle', pack: Ref<TextStyleToken>\|null` | write/clear `Site.elementDefaults[tag]` row + textStyle ref | restore prev/re-add |
| `swapToken` | `fromToken: Ref<StyleToken>, toToken: Ref<StyleToken>` | re-point every usage (does NOT delete fromToken) — **usage-rewrite, surfaces in Styling area** | `swapToken(to,from)` |

> Dedup / open: `setUserManagedFont` (Site.userManagedFonts Set<string>) is currently lens-DROP —
> **excluded** pending the §5 V-decision (tiny font-settings intent vs separate settings area). The
> two coexisting color models (`StyleToken{Color}` + newer `ColorToken`) are ONE logical "color
> token" intent with two backing classes — do NOT split into two ops (tracks a transient migration
> the model is actively deleting). `deletePalette`/`deletePaletteFunction`/`removeFont` are the
> mirror-deletes folded above (one per create).

### 1.6 Params / States / Types (29 ops)

Three families: (A) State lifecycle/identity, (B) type-shape internals, (C) arg-shape/return-shape/
emitter tree. A State with a `UnionType` IS a variant group → owned by §1.7; this area is non-variant
states.

**A. State lifecycle (7)**

| op | params | effect | inverse |
|---|---|---|---|
| `addState` | `owner: Component\|Site, name, type: StateAllowedType, defaultExpr?, exposed?, represents?, description?` | materialize `State` + type/default/exposed children + push `states`/`globalStates` | `removeState` |
| `removeState` | `state` | detach + cascade (ref-guarded) | `addState` |
| `renameState` | `state, name: string` | set `State.name` (re-uniquified) | restore prev |
| `retypeState` | `state, type: StateAllowedType` | replace `State.type` child (UnionType non-removable once set) | `retypeState(prev)` (clean iff not union) |
| `setStateExposure` | `state, exposed: boolean, onChange?` | flip `State.exposed` null↔ExposedSpec (allocates preview) | `setStateExposure(!)` (asymmetric) |
| `setStateDefault` | `state, defaultExpr: Expr\|null` | set/clear `State.defaultExpr` | restore prev |
| `markStateDerivation` | `state, isDerivation: boolean` | set `State.represents` 'derivation'↔null | `markStateDerivation(!)` |
| `setStateDescription` | `state, description: string\|null` | set `State.description` | restore prev |

**B. Type-shape internals (8)**

| op | params | effect |
|---|---|---|
| `editChoiceOptions` | `type: ChoiceType, op: 'add'\|'remove'\|'reorder'\|'relabel', option, atIndex?` | mutate `ChoiceType.options` |
| `editUnionValues` | `type: UnionType, op: 'add'\|'remove'\|'rename', value, displayName?` | mutate `UnionType.values` |
| `bindFeatureFlagSource` | `type: UnionType, source: Ref<ProviderSource>\|null` | set/clear `UnionType.source` |
| `editFormSchema` | `type: FormType, op: 'addField'\|'removeField'\|'reorderFields', field, atIndex?` | mutate `FormType.schema` |
| `editFormRule` | `type: FormType, op, rule, message?` | mutate `FormType.rules` |
| `editClassNameSelectors` | `type: ClassNamePropType, op, selector` | mutate `selectors` |
| `setClassNameDefaultStyles` | `type: ClassNamePropType, props: Partial<StudioCSSPropertyValues>` | set `defaultStyles` entries |
| `setHtmlTagConstraint` | `type: HtmlTagType, defaultTag?, allowedOp?, tag?` | set `defaultTag`/mutate `allowed` |
| `toggleColorDeref` | `type: ColorPropType, noDeref: boolean` | set `noDeref` |
| `toggleRefKind` | `type: RefType, callbackRef: boolean` | set `callbackRef` |

**C. Arg-shape / return-shape / emitter (the "slot cluster" — PLANNED-BUT-ABSENT) (12)**

| op | params | effect |
|---|---|---|
| `addArgSlot` | `parent: ArgParent, shape: ArgShape, key?, atIndex?` | materialize arg-shape node into parent collection |
| `removeArgSlot` | `shape` | detach arg-shape node |
| `reorderArgSlots` | `parent, fromIndex, toIndex` | reorder positional arg collection (→ **W2 reorder**) |
| `relabelArgSlot` | `slot, displayName?, name?` | set `displayName` (curator) / `name` (wire) |
| `setArgSlotRequired` | `slot, required: boolean\|null` | set `ArgSlot.required` |
| `setArgSlotPriority` | `slot, priority: number\|null` | set `ArgSlot.priority` |
| `setArgSlotRole` | `slot, role: 'callbackAsSignal'\|null` | set `ArgSlot.role` |
| `setArgSlotDefault` | `slot, which: 'default'\|'preview', expr: Expr\|null` | set/clear default/preview expr |
| `retypeArgSlot` | `slot, type: ArgAllowedType\|null` | replace `ArgSlot.type` child |
| `editArgSwitchArms` | `sw: ArgSwitch, op: 'add'\|'remove', value` | mutate `ArgSwitch.matches` |
| `editReturnShape` | `parent: ReturnParent, op: 'addField'\|'removeField'\|'retarget', key, shape, target?` | mutate return shape / `ReturnSlot.target` |
| `setReturnStateWiring` | `record: ReturnRecord, readKey, writeKey: string\|null` | set/clear `stateWiring[readKey]` |
| `declareEventEmitter` | `slot: ReturnSlot, style: 'node'\|'browser'\|null` | set/clear `ReturnSlot.eventEmitter` |
| `editEmitterEvents` | `decl: EventEmitterDecl, op, name, payloadType?` | mutate `events` |
| `setShapeRepresents` | `node, represents: string\|null` | set open-set semantic tag (weakest — EMIT-terse/DROP) |

### 1.7 Variants & Environments (12 ops)

Two entities — `VariantGroup` (axis) + `Variant` (option) — plus precedence + the lifecycle clause.
Environments are subjects (refs), not authored content. `cascadeOrder`/`axis-kind` are DERIVED →
not operations (a quirk-knob would violate intent>materialization).

| op | params | effect | inverse |
|---|---|---|---|
| `addVariantAxis` | `owner: Ref<Component\|Site>, subject, name?, standalone?, initialVariants?` | materialize `VariantGroup` under owner (+ backing State for newState subject; virtual-genesis env seed DROPs) | `removeVariantAxis` |
| `removeVariantAxis` | `group` | detach group + cascade child variants + drop combo-keyed aspects from tree (+ backing State) | `addVariantAxis` (lossy) |
| `renameVariantAxis` | `group, name: string` | set `VariantGroup.name` (lockstep w/ backing State; pseudo = re-key) | restore prev |
| `setVariantAxisToggleMode` | `group, standalone: boolean` | flip `VariantGroup.standalone` | `setVariantAxisToggleMode(!)` |
| `rebindVariantAxisSubject` | `group, subject` | re-point `VariantGroup.subject` (re-validate variants) | restore prev |
| `promoteVariantAxis` | `group, toOwner: Ref<Site>` | reparent component-local group → Site (the reparent with `from` present) | demote |
| `addVariant` | `group, name?, operator?, right?` | materialize `Variant` into `group.variants` | `removeVariant` |
| `removeVariant` | `variant` | detach + drop combo-keyed aspects naming it (+ pseudo prune) | `addVariant` (lossy) |
| `renameVariant` | `variant, name: string` | set `Variant.name` (uniquified) | restore prev |
| `setVariantCondition` | `variant, operator: VariantOperator\|null, right: CustomCode\|Ref<UnionValue>\|Ref<PageComponent>\|null` | set `Variant.operator` + polymorphic `right` | restore prev |
| `setVariantDescription` | `variant, description: string\|null` | set `Variant.description` | restore prev |
| `reorderVariantPrecedence` | `owner: Ref<Component\|Site>, order: Ref<VariantGroup>[]` | rewrite `variantPrecedence` ref-list (weakest→strongest) | restore prev |
| `setLifecyclePredicateClause` | `hook: Ref<LifecycleHook>, variantGroup, mode: 'if'\|'unless', values: Ref<Variant>[]` | add/edit `VariantPredicateClause` — **cross-area: owned by Behavior (§1.8), referenced here** | restore prev |

> Dedup: `cloneVariant`/`cloneVariantGroup` are composite macros (`addVariant` + N
> `setStyleProperty`) → NOT primitives (would double-count against Styling). `VariantsCombination`
> (node activation) → render-tree/node-activation area, NOT here. The 4-verb MCP construction split
> (add-variant-group / create-display-state / create-media / create-prop) collapses onto
> `addVariantAxis` + `addVariant`.

### 1.8 Behavior / Interactions / Expressions (20 ops)

| op | params | effect | inverse |
|---|---|---|---|
| `wireEventHandler` | `element, eventKey: {attr}\|{param}, intents: ActionIntent[], declaration?` | attach `EventHandler` to a slot (DOM event or callback prop); ROOT merge-anchor of the cascade | `removeBehaviorSubtree(element, eventKey)` |
| `addReactiveHandler` | `owner, handlerKind: 'signal'\|'lifecycle', signals?, variantPredicate?, setup?, effect, teardown?, concurrencyMode?` | materialize `Handler` subclass + children + push `owner.handlers` | `removeBehaviorSubtree` |
| `addInteractionStep` | `container: ActionIntent\|Handler, stepName, condition?, action, index?` | materialize `ActionStep`/`InteractionStep` into the step list | `removeInteractionStep` |
| `renameInteractionStep` | `intentOrStep, name: string` | set step name | self-inverse |
| `setStepCondition` | `step, condition: boolean\|CustomCode` | set `step.condition` | restore prev |
| `setStepAction` | `step, action: Action` | replace `step.action` subtree (closed 4-member union) | restore prev |
| `setNavigationTarget` | `action: NavigationAction, destination: CustomCode\|PageHref\|null` | set `NavigationAction.destination` | restore prev |
| `setNavigationNewTab` | `action, newTab: boolean\|null` | set `NavigationAction.newTab` | self-inverse |
| `editCustomFunctionAction` | `action: CustomFunctionAction, code: string, scope, represents: 'action'\|null` | set `CustomCode` body + represents (state/variant/toast mutations ALL ride here) | restore prev |
| `setInvokeOperation` | `action: InvokeOperation, operation: Ref<ValueOperation>` | re-point `InvokeOperation.operation` | restore prev |
| `bindInvokeOperationArg` | `action, slot: Ref<ArgSlot>, expr: CustomCode\|null` | set/delete `InvokeOperation.args[slot]` | restore prev |
| `setQueryInvalidation` | `action: InvalidateQueryAction, invalidateAll: boolean, targets[]` | configure `QueryInvalidationSelector` — **cross-area: action lives in Behavior, targets ref Data; owned here** | restore prev |
| `editHandlerPhase` | `handler, phase: 'setup'\|'teardown', code: CustomCode\|null` | set/clear phase `CustomCode` | restore prev |
| `setHandlerConcurrency` | `handler, concurrencyMode: 'takeLast'\|'sequential'\|'parallel'\|'once'\|null` | set `Handler.concurrencyMode` | self-inverse |
| `setHandlerSignals` | `handler: SignalHandler, signals: Signal[]` | edit `SignalHandler.signals` (each Signal own entity) | restore prev |
| `editLifecyclePredicateClause` | `hook: LifecycleHook, clauses: VariantPredicateClause[]` | edit `variantPredicate` — **the behavior-side owner of the §1.7 cross-area op** | restore prev |
| `editExpression` | `container: CollectionExpr\|MapExpr\|PageHref\|StyleExpr, edit` | mutate structured expr container (list/map/route/styles) — **owns `setCustomSelector` via StyleExpr** | inverse edit |
| `editApplicationBinding` | `application: PartialApplication\|FiniteApplication, edit` | edit a β-reduction stage (bindings/localSlots/groupContributions) | inverse edit |
| `removeBehaviorSubtree` | `subtree, from` | detach a behavior entity + cascade owned subtree — single inverse anchor | the corresponding add/wire (NOT clean for deep subtrees → CRDT restore) |

> Dedup: `editLifecyclePredicateClause` (here) and `setLifecyclePredicateClause` (§1.7) are the SAME
> forward mutation seen from two areas — **one op, owned by Behavior** (the clause is a `LifecycleHook`
> child); §1.7 references it. `setQueryInvalidation` (action-level) is distinct from
> `setDataSourceInvalidation`/`setOperationInvalidation` (definition-level, §1.9). `set-state`/
> `toggle-state`/`increment-state` are NOT distinct ops — all `editCustomFunctionAction` with a
> recognized code shape.

### 1.9 Data / Queries / Operations / Imports / Splits / Collaboration (~58 ops)

The largest area; near-totally NEW (only ~8 map to MCP `data-sources`, ~7 to `CommentsRepo`).

**Data sources & queries (20)** — `addDataSource`, `relabelDataSource`, `setDataSourceFetchKind`,
`pointDataSourceAtFunction`, `introduceDataSourceSlot`, `bindDataSourceSlot`, `unbindDataSourceSlot`,
`setDataSourceInvalidation`, `clearDataSourceInvalidation`, `linkDataSourceExternal`,
`configureDataSourceCustomType`, `removeDataSource`, `importOpenApi` (bulk macro — one cut, N DSDs);
`addQuery`, `renameQuery`, `bindQuerySource`, `bindQueryArgument`, `unbindQueryArgument`,
`setQueryGate`, `wireQueryNodeRef`, `removeQuery`.

**Operations (ValueOperation) (8)** — `addOperation`, `relabelOperation`, `setOperationKind`,
`editOperationSignature`, `repointOperationSource`, `setOperationInvalidation`,
`clearOperationInvalidation`, `removeOperation`.

**Imports (11)** — `addNpmPackage`, `bumpNpmPackageVersion`, `cacheNpmPackageTypes`,
`removeNpmPackage`; `addCodeLibrary`, `retargetImport`, `removeCodeLibrary`; `addCustomFunction`,
`removeCustomFunction`; `registerHostlessPackage`, `editHostlessManifest`, `removeHostlessPackage`.

**Project variables (3)** — `addProjectVariable`, `editProjectVariable`, `removeProjectVariable`
(the model entity is `Definition`, NOT a literal `ProjectVariable`).

**Splits (7)** — `addSplit`, `setSplitStatus`, `editSplit`, `addSplitSlice`, `rebalanceSplitSlice`
(`prob` is a **0–100 percentage**, not a fraction), `removeSplitSlice`, `removeSplit`.

**Comments / collaboration (11)** — `postComment`, `replyToComment`, `editComment`,
`toggleCommentReaction`, `resolveCommentThread`, `reopenCommentThread`, `setCommentTaskFields`,
`archiveCommentThread`, `deleteComment` (soft-delete, terminal), `reanchorCommentThread`. These
mutate the **separate comments doc** (Path B, via `CommentsRepo`) — not the prime Site doc.

(Full param/effect/inverse tables for §1.9 live in the per-area derivation; reproduced verbatim in
the reconciliation table §2 where the existing-surface mapping is the load-bearing detail.)

> **★ Intentional non-orthogonality (the one allowed overlap):** `importOpenApi` ⊃ `addDataSource`
> (macro ⊃ primitive — the macro avoids N round-trips, the primitive is the floor) and
> `addDataSource` ≈ `addOperation` (the unresolved DSD↔ValueOperation migration — see V-decision §5).
> Every other op-pair is disjoint.

**Total: 32 + 19 + 22 + 16 + 22 + 29 + 12 + 20 + 58 = ~230 forward operations** across 9 areas.

---

## 2. The RECONCILIATION table

Each operation classified against the existing surfaces (siteOps/TplMgr studio + MCP `projectEditingTool`):

- **ALIGNED** — already present, same shape. The op IS an existing method/verb.
- **SUPERSET** — extend an existing op (it covers a subset of the cases).
- **NEW** — genuinely absent on both surfaces (today a direct model write inside `transact()` or an
  importer/sync side-effect, with no named method or verb).

| area | ALIGNED (existing method/verb) | SUPERSET (extend) | NEW (absent) |
|---|---|---|---|
| **Project/Site/Arenas** | `addArtboard`→`addNewMixedArenaFrame`; `removeArtboard`→`removeExistingArenaFrame`/`removeMixedArenaFrame`; `moveArtboardToArena`→`moveFrameToArena`; `addArena`→`Site.addArena`; `removeArena`→`removeArena`/`removeMixedArena`; `addDependency`/`removeDependency`/`upgradeDependency`→`plexus.{add,remove,replace}Dependency`; `setPageRoute`→`changePagePath` (also MCP `component-meta:set-path`); `setArtboardVariantTarget`(clear)→`clearFrameComboSettings`; `setArtboardViewMode`/`setArtboardBackground`→studio inline writes; `unbindDefaultComponentRole`→inline `delete site.defaultComponents[k]` | `addArtboardWithVariants`→`addNewMixedArenaFrameWithVariants`; `setArtboardVariantTarget`(set) | `renameProject`, `createProject`, `renameArena`, `reorderArena`, `repositionArtboard`, `resizeArtboard`, `renameArtboard`, `setSiteFlag`, `setDiagnostics*`×3, `bindDefaultComponentRole`, `setPageWrapper`, `setPageQueryParam`, `setPageSeo`(desc/canonical/og) |
| **Component lifecycle** | `removeComponent`→`removeComponentGroup`/MCP `component-meta:delete`; `renameComponent`→`tryRenameComponent`/MCP `rename`; `duplicateComponent`→`cloneComponent`; `setPageRoute`→`changePagePath`/MCP `set-path`; `addSlot`→`addSlotParam`/MCP `props-slots:add-slot`; `renameSlot`→`renameParam`; `removeSlot`→`removeComponentParam` | `addComponent`→`TplMgr.addComponent` (studio-present, **MCP-ABSENT — the structural gap**); `setPageSeo`→MCP `set-metadata` (no openGraphImage) | `registerCodeComponent`(MCP), `setComponentFlag`, `setComponentMetadata`, `setSlotMetadata`, `setSlotAllowedChildren`, `setSlotCallback`, `setComponentTemplateInfo`, `setFigmaMapping`, `setCodeComponentMeta`, `setCodeComponentSubMeta`, `setPageQueryParam` |
| **Tpl tree** | `add-node`/`move-node`→MCP `tree:place-node`; `insert-children`→`tree:insert-children`; `remove-node`→`tree:remove-node`; `clone-node`/`wrap-node`/`unwrap-node`/`replace-node`→`tree:*`; `set-text`/`bind-text`→`style:set-text`/`set-text-expr`; `set-attribute`/`remove-attribute`→`attributes:*`; `set-arg`/`clear-arg`→`component-args:*`; `set-repeater`/`remove-repeater`→`visibility-repeater:*` | `set-semantic-type`→partial (Text via set-text side-effect only) | `retag-node`, `rename-node` (studio `renameTpl`, no MCP), `set-locked`, `set-prop-spread`, `remove-prop-spread`, `clear-text` |
| **Styling/RuleSet/layers** | `setStyleProperty`→MCP `style:set-style`; `setStyleProperties`→`set-styles`; `clearStyleProperty`→`remove-style`; `addLayer`/`removeLayer`/`reorderLayer`→`layers:*` (shadow/filter/backdrop/transform/bg) | `editLayerField`/`setLayerOverride`/`setLayerVisibility`→`configure-shadow-layer` (SHADOW-ONLY; model is general) | `attachStylePack`, `detachStylePack`, `setEffectsScalar` (**broken: set-style writes dead `_values`**), `setBoxRecipe`, `setTextStyle`, `setDefaultTransition`, `setPropertyTransitions`, `setKeyframeAnimation`, `removeKeyframeAnimation` (motion = entirely unimplemented), `clearVariantRuleSet`(partial→`cleanRedundantOverrides`) |
| **Tokens & Theme** | `createToken`→MCP `tokens:add-token` (scalar StyleToken only); `deleteToken`→`tokens:remove-token`/`tryDeleteTokens`; `swapToken`→`swapTokens`; `createAsset`/`editAsset`/`deleteAsset`→`createImageAsset`/`updateImageAsset`/`removeImageAsset`/`tryDeleteImageAssets` | `createToken`→add color/composite kinds + valueKind/cluster/tags; `deleteToken`→composite/palette/font | `renameToken`, `setTokenValue`, `clearTokenValue`, `aliasToken`, `setTokenComposition`, `setTokenExportTier`, `setTokenClassification`, ALL palette ops×5, ALL font ops×3, `setElementDefault` (16 of 22 are NEW) |
| **Params/States/Types** | `removeState`→`removeState`/MCP `remove-state` (refuses variant); `renameState`→`renameParam` (no MCP) | `addState`→`addComponentState`/MCP `create-state` (text/num/bool ONLY); `retypeState`→`updateState{variableType}` (subset alphabet); `setStateExposure`→`updateState{accessType}` (no MCP) | `markStateDerivation`, `setStateDefault`, `setStateDescription`, **ALL of family B (8 type-shape ops)**, **ALL of family C (12 arg-shape/return/emitter ops)** — Families B & C have ZERO imperative surface (the "slot cluster" TODO) |
| **Variants & Env** | `addVariantAxis`→`createVariantGroup`/`createGlobalVariantGroup`/`createScreenVariantGroup`; `removeVariantAxis`→`tryRemoveVariant`+`removeGlobalVariantGroup`; `renameVariantAxis`→`renameVariantGroup`/`renamePseudoVariant`; `addVariant`→`createVariant`/`createScreenVariant`; `removeVariant`→`tryRemoveVariant`/`removeGlobalVariant`; `renameVariant`→`renameVariant`; `reorderVariantPrecedence`→MCP `precedence:reorder-precedence` (component-local) | `addVariantAxis`→MCP 4-verb construction split folds in; `reorderVariantPrecedence`→site-level + combo | `setVariantAxisToggleMode`, `rebindVariantAxisSubject`, `promoteVariantAxis`, `setVariantCondition`, `setVariantDescription` (the 5 edit-side verbs) |
| **Behavior/Interactions** | `wireEventHandler`→MCP `state-events:set-event-handler` (attr-key only); `removeBehaviorSubtree`→`remove-event-handler` | `addInteractionStep`→`add-interaction` (appends whole ActionIntent, not a step into one; no reactive path); `setNavigationTarget`/`editCustomFunctionAction`/`setInvokeOperation`/`setQueryInvalidation`→`buildInteractionAction` tuple kinds (handler-build-time only) | `addReactiveHandler` (+ `editHandlerPhase`/`setHandlerConcurrency`/`setHandlerSignals`/`editLifecyclePredicateClause` — reactive handlers have NO surface), `setStepCondition`, `setStepAction`, `setNavigationNewTab`, `bindInvokeOperationArg`, `editExpression`, `editApplicationBinding` |
| **Data/Queries/Ops/Imports/Splits/Comments** | `addDataSource`→`data-sources:create-data-source`; `introduceDataSourceSlot`/`bindDataSourceSlot`/`unbindDataSourceSlot`→`data-sources:*`; `bindQueryArgument`→`set-cdq-binding`; `importOpenApi`→`import-openapi`; `addQuery`→`add-query`; `removeQuery`→`remove-query`/`removeComponentQuery`; ALL comment ops→`CommentsRepo.{createRoot,createReply,edit,toggleReaction,resolve,reopen,setArchived,delete}` | (none — the data-sources cluster is the only seed) | **ALL of Operations (8)**, **ALL of Imports (11)**, **ALL of Project Variables (3)**, **ALL of Splits (7)**, the DSD edit/remove tail (`relabelDataSource`, `setDataSourceFetchKind`, `pointDataSourceAtFunction`, `setDataSourceInvalidation`, `linkDataSourceExternal`, `configureDataSourceCustomType`, `removeDataSource`), `renameQuery`/`bindQuerySource`/`unbindQueryArgument`/`setQueryGate`/`wireQueryNodeRef`, `setCommentTaskFields`/`reanchorCommentThread` |

**Reconciliation summary (rough counts):** ~55 ALIGNED · ~12 SUPERSET · ~165 NEW. The vocabulary is
overwhelmingly **larger than the existing surfaces** — which is the honest finding, not an
indictment: most of these mutations happen today as **direct model writes inside `studioCtx.transact()`
blocks** (panels) or as **importer/sync side-effects**, with no named method. The forward vocabulary,
if realized, would be the **first consolidated facade** for ~5 entire entity families (Operations,
Imports, Project Variables, Splits, the type-shape/slot cluster). **This is a reveal, not a redundancy.**

---

## 3. CONVERGENCE analysis (the big architectural question — V's call)

Three forward surfaces exist today and they all aim at the same semantic space:

1. **siteOps/TplMgr** — studio gestures. ~61 mutation methods + 10 helpers. `one transact() = one
   seq = one operation` (load-bearing for the lens's `groupBy(seq)`). Coarse where it's coarse
   (`updateState(Partial<StateType>)` is a grab-bag Object.assign, not named verbs).
2. **MCP `projectEditingTool`** — agent verbs. 13 clusters, ~82 actions. Value-shape, receiver-
   dispatched, flat-parameterized (LLM-optimized). Covers component-INTERNAL editing richly; thin/
   absent on arena/page/dependency/diagnostics/role/tokens-beyond-scalar/operations/imports/splits.
3. **This derived vocabulary** — the model-totalic forward set (~230 ops).

### 3.1 Where they already agree
- **Tree structure** — near 1:1 (`add/move/remove/clone/wrap/replace/unwrap-node` ↔ MCP `tree`).
- **Per-node aspects** — clean (`set-style`/`set-attribute`/`set-arg`/`set-text` ↔ their clusters,
  co-located with the aspect they write — the cluster cut is sound).
- **Arena-frame lifecycle** — siteOps owns it richly (`addNewMixedArenaFrame` et al.).
- **Variant construction** — three surfaces converge on `addVariantAxis`+`addVariant` (the MCP
  4-verb split is a construction-flow superset of the 2 model ops).
- **Comments** — `CommentsRepo` is already a clean per-op facade (the application boundary the
  substrate doesn't enforce).

### 3.2 Where they diverge
- **Granularity.** siteOps `updateState` is one coarse setter; the vocabulary decomposes it into 6
  named verbs. MCP `buildInteractionAction` collapses step+action-kind+payload into one tuple at
  handler-build-time; the model is finer (edit an existing step's condition/action in place).
- **Coverage asymmetry.** siteOps covers creation/destruction broadly but field-edits as direct
  writes; MCP covers component-internal editing but **cannot create a component, add a reactive
  handler, author an Operation/Import/Split/Project-Variable, or edit most token kinds**. The two
  surfaces have *almost no overlap* in their gaps — siteOps's gaps are MCP's strengths and vice
  versa, which is exactly why neither alone is the intent layer.
- **Addressing model.** MCP is context-element-relative (`ctx.element`, receiver-dispatch); siteOps
  is entity-ref-direct. The vocabulary is entity-ref-direct (params carry resolved entities),
  sidestepping both the receiver-dispatch and the W1 key-loss issues on the forward side.
- **The DSD↔ValueOperation duplication.** Two parallel callable systems with near-identical shapes;
  the MCP `data-sources` cluster drives DSD, the runtime `mutate`-action constructs ValueOperation.

### 3.3 The options (lay out — do NOT decide)

**Option A — One unified intent layer, MCP-as-the-realization.** Treat the derived vocabulary as the
spec; grow the MCP `projectEditingTool` clusters (+ new `operations`/`imports`/`splits`/`palettes`/
`theme`/`reactive-handlers` clusters) to total coverage, and make siteOps a thin caller of the same
underlying named ops. **Cost:** large — ~165 NEW verbs to surface, decompose `updateState` and the
`buildInteractionAction` tuple, build the slot cluster (already TODO'd). **Win:** agent ↔ studio
parity through ONE vocabulary; the lens recognizers map 1:1; the actor-corollary ("expose intent
verbs") is finally met for arenas/operations/imports/etc. that an agent literally cannot touch today.

**Option B — Two surfaces, shared op-core, no single API.** Keep siteOps (studio) and MCP (agent)
as distinct front-doors, but extract the *named operations* as a shared library both call (siteOps
stops doing direct writes; MCP stops doing tuple-collapse at the edge). **Cost:** medium — refactor
both to call the op-core; no new public API shape. **Win:** removes the direct-write divergence
(every mutation becomes a named op → the lens recognizer is reliable) without forcing MCP's flat
LLM-shape onto studio or studio's entity-ref shape onto MCP.

**Option C — Leave forward surfaces as-is, vocabulary is spec-only.** The ~230 ops are a *reference
spec* the lens uses as a recognizer catalog; the forward surfaces stay split and partial. **Cost:**
near-zero. **Win:** none beyond documentation — the agent gaps persist, the direct-writes persist,
the lens keeps degrading where no named op exists (acceptable, since the lens is designed to).

**The cross-cutting sub-decision (independent of A/B/C):** does the MCP keep its deliberate
*coarse* call-shape (the tuple-replace-whole-handler, the flat params — per the call-shape research
that flat is LLM-better) or adopt the model-fine granularity? Recommendation embedded in the
options: **build the narrow/coarse MCP first, add fine ops only on concrete agent need** — the
tuple-replace surface is a deliberate minimal, not a deficiency. This is V's product judgment.

---

## 4. CORE DEPENDENCIES (the two widenings, folded in)

These are **domain-agnostic** widenings of the core `PlexusChange` shape. They unblock the
**backward** (describing) layer's recognition of these forward ops — the forward ops themselves are
**total and well-defined without them** (they carry keys/indices as typed params). The dependency is
one-directional: the lens needs the richer change to *round-trip* a forward op into a described event.

### 4.1 W1 — capture the map/record entry key → `PlexusChange.key?`

**What:** `resolveContainer` (lift.ts) climbs to the owner and returns `owner.parentSub` as `field`
(the collection name), discarding the changed entry's own key (`item.parentSub`). W1 adds one
optional public field `key?: string` and carries `item.parentSub` for the Y.Map (record/set/map)
case. Arrays keep `key` absent (`parentSub === null` there). XmlElement attribute changes already
carry their name in `field` — `key` is exclusively for insert/remove-on-a-Y.Map.

**Edits:** ~5 small edits in lift.ts + 1 optional field in types.ts (~6 lines). Purely additive;
verified backward-compatible against operators/restore/lift tests + the e2e add-Card snapshot.

**Unblocks (backward recognition of these forward ops' keys):** `setSiteFlag` (flag name),
`setDiagnostics*` (rule/bucket id), `bindDefaultComponentRole` (role), `setPageQueryParam` (param),
`setComponentMetadata` (key), `set-attribute` (attr name), `set-arg` (prop), `setClassNameDefaultStyles`
(CSS prop), `setReturnStateWiring` (readKey), `linkDataSourceExternal` (provider), `toggleCommentReaction`
(`user:emoji`), `setElementDefault` (tag), composite `setTokenValue` (CSS prop), pseudo
`renameVariantAxis` (selector) — ~15 humanizations across 6 areas, each of which today degrades to a
key-agnostic phrasing. Also indirectly unblocks the **entity-keyed-map** ops (`bindInvokeOperationArg`,
`bindQueryArgument`, `wireQueryNodeRef`, `setDataSourceInvalidation.matchSlots`) whose map key is an
owning-entity uuid the lens then derefs.

**Risk:** VERY LOW (additive optional field; no consumer reads it today; attr-name-in-`field` vs
map-key-in-`key` split is exact and the lens already models it). Known non-regression follow-up:
`blame.ts` folds on `field` only, so two different attrs still collapse to one blame bucket — W1
makes the `field+key` fix *possible* later but does not auto-apply it.

### 4.2 W2 — emit the `reorder` verb for same-ref remove+insert within one cut

**What:** A child-list move surfaces as a `delete` + `insert` of the same child-ref in one cut
(Yjs/Plexus have no atomic array-move). W2 buffers array inserts/removes per `(entity.uuid, field)`,
then a reconciliation pass emits ONE `reorder` (with `index?: number` = destination position,
recovered by walking the live archive array) for any value present in both, and falls back to plain
insert/remove for the rest. The `reorder` verb already exists in the Verb union and `annotate.ts`
already has the switch arm — the dead arm goes live.

**Edits:** ~25–35 lines in lift.ts (one buffer + one reconciliation pass + a `liveArrayIndexOf`
helper) + optional `index?: number` in types.ts.

**Unblocks (backward recognition of every reorder op):** `reorderArena`, `repositionArtboard`
(canvas), `reorderLayer` (bg/shadow/filter stacks), `reorderArgSlots`, `editChoiceOptions(reorder)`,
`reorderVariantPrecedence`, `editHostlessManifest`(list reorder). Today each surfaces as a spurious
remove+insert PAIR that a net-diff consumer double-counts as "removed X" + "added X". The `index?`
also unblocks DIRECTIONAL phrasing ("moved to position 3") otherwise unrecoverable.

**Risk:** LOW-MODERATE — adds reconciliation LOGIC, not just a field. The shape is safe (`reorder`
pre-declared, `index?` additive). The behavioral change (an in-cut remove+insert pair becomes one
`reorder`) is precisely the bug being fixed; verified the lift/e2e tests don't exercise a same-cut
pair so snapshots stay green. The real risk surface is the **false-positive**: a genuine same-cut
remove-then-readd-of-the-same-ref-without-reparent gets labeled `reorder`. Verified rare (real
removals clear the `\0` ownership pointer → a co-occurring detach/reparent in the cut is the
available discriminator); recommendation is **build the narrow value-match version first, add the
detach-co-occurrence guard only if a real false-positive appears**. Index recovery is O(list length)
per moved value — bound it / fall back to index-absent above a threshold.

> **These widenings stay in core and remain domain-blind.** `key` is literally the CRDT entry key;
> `reorder`+`index` is literally a Y.Array move. No here.build semantics leak into core — the clay
> tenet holds. The lens consumes the richer-but-still-agnostic change.

---

## 5. V-DECISIONS (the genuine product judgment calls this surfaced)

1. **CONVERGENCE: one intent layer or two? (§3, the big one.)** Option A (unify on MCP-as-realization)
   / B (shared op-core, two front-doors) / C (spec-only, leave split). And the sub-decision: keep the
   MCP's deliberate *coarse* call-shape (tuple-replace, flat params — LLM-better per the call-shape
   research) or adopt model-fine granularity? Recommendation embedded: build coarse first, add fine
   ops on concrete agent need.

2. **DSD ↔ ValueOperation: is one legacy?** The model is mid-migration (`ValueOperation` docstring:
   "Replaces DataSourceDefinition for the common case"). `addDataSource`≈`addOperation` is the one
   non-orthogonality in the set. If ValueOperation supersedes DSD, the closed set should *collapse*
   `DataSourceChanged`→`OperationChanged` over time, not carry both forever. (Couples to the MEMORY
   note on Environment/EnvCapability legacy-vs-right-model — same shape of question.)

3. **The MCP whole-component CREATE gap (the actor-corollary breach).** `addComponent`/
   `registerCodeComponent`/`duplicateComponent` are studio-only; the MCP has no create-component verb
   (only edits components already in context). An agent literally cannot add a Plain/Page/Frame
   component, register a code component, add a canvas, place an artboard, set a page route, add a
   dependency, bind a role, or author an Operation/Import/Split through the capability surface. Is
   the agent surface *meant* to reach these? If yes, ~165 NEW verbs (esp. reactive handlers + the
   whole Data/Imports/Splits area) need MCP homes.

4. **Cross-area invalidation ownership.** `DefinitionInvalidationTarget` is owned three ways
   (DSD.invalidates, ValueOperation.invalidates, action-level QueryInvalidationSelector). The
   vocabulary places `setDataSourceInvalidation`/`setOperationInvalidation` in Data and
   `setQueryInvalidation` (action-level) in Behavior. Confirm the cut so invalidation isn't
   double-minted (mirrors the wave-1 `VariantsCombination` ownership question).

5. **`setShapeRepresents` / `setComponentMetadata` salience & `userManagedFonts`.** The weakest EMITs:
   curator annotations (`represents` open-set tag), arbitrary metadata, machine stamps
   (`cacheNpmPackageTypes`). And `userManagedFonts` (Set<string>, currently lens-DROP). Are these
   real authored operations, a separate "settings" area, or permanent DROP-class (the closed forward
   op can exist while the backward event is dropped — the asymmetry is legal)?

6. **Page-area boundary.** `setPageRoute`/`setPageQueryParam`/`setPageSeo` mutate `PageMeta` (a
   `PageComponent` child) but are the site routing/SEO surface. Filed canonically under Component
   lifecycle (§1.2); Project/Site/Arenas (§1.1) references them. Confirm the single home to avoid
   double-emission.

7. **`createProject` EMIT/snapshot disposition.** Is project genesis an operation (EMIT anchor +
   genesis-DROP) or the snapshot-as-t0 floor? (Wave-1 doc §4.2.1 left this open.)

8. **`setBoxCoupling` exclusion.** Presentation-only (no emitted CSS), no lens event kind — excluded
   from the closed set as DROP-class. Confirm it is not a project intent worth carrying.

---

## 6. Restating the invariant (the layering boundary, one more time)

This operations vocabulary is the **FORWARD / prospective** surface: a closed, total, orthogonal,
minimal set of imperative verbs, each a deterministic function `operation → PlexusChange[]`. It is
what an actor (human via studio, agent via MCP) can DO.

The **describing layer** (`intent-lens-design.md`) is the **BACKWARD / retrospective** recognizer:
`PlexusChange[] → IntentEvent[]`. It is lossy and partial — many changes (CRDT merges, repairs, raw
writes, machine stamps) have no operation behind them. It **USES** this vocabulary as a recognizer
(it labels a recognized change-cluster with an operation name) but **does NOT depend on it** and
never fails when no operation matches.

The dependency arrow points one way (describing → operations, as labels). The two core widenings
(§4) enrich the *backward* recognition; they leave the *forward* ops total and unchanged. **Intents
and descriptions stay separate.**
