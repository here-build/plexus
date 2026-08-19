# The Lens Architecture — object × facet × typed-coordinate

> Status: the evolved architecture (2026-06-24), crystallized with V. **SUPERSEDES the "9 parallel areas"
> framing** in `intent-lens-design.md` §1 — those areas were really *three different kinds of thing* mixed
> together (objects, facets-of-an-object, and the variance axis). This is the current organizing principle.
> "Not whole, but closer" (V) — the object set + facet vocabularies are still converging; the open edges are
> marked at the end. Do not treat this as final.

## The reframe: not areas — three categories

The describing layer (`PlexusChange[] → IntentEvent[]`) is the **studio's own intent-over-materialization line
applied to the LOG**. Every entity the lift surfaces is exactly one of:

| category | what it is | membership test | examples |
|---|---|---|---|
| **OBJECT** (subject) | the noun a user *names* | "does the user name it?" | component, element, token, state, data-query (+ more) |
| **COORDINATE** (axis) | an addressing dimension *on* a change | it's a `Map<value, X>` **key** | variance (typed), a State (overrides / args) |
| **APPLICATION PATH** | materialization the user never names | the `X` in any `Map<value, X>`, + wrappers | RuleSet · EventHandlersSet · ActionIntent · FrameConfig · exprs · the variant-keyed maps |

**Every event is `(object · facet-changed · coordinate)` — and only the object is a noun.** Application-path
entities don't get events; they **resolve up** to their object and collapse into a facet-change on it.

```
   <object>    <facet changed>     <coordinate>
   element     background → red    under danger
   subject     what about it       intent axis (typed)
```

## 1. Objects — the closed registry

The test is V's intent-over-materialization line: *does the user name it?* They name a component, an element, a
token; they never name "the danger-combo RuleSet's background expr." V's core list + the converging "probably
more":

| object | model entity(ies) |
|---|---|
| Component (incl. Page) | `PlainComponent` / `PageComponent` / `FrameComponent` |
| Element | `TplTag` / `TplComponent` / `TplSlot` |
| Token | `ColorToken` / … (+ `ColorPalette`, `CustomFont`?) |
| State | `State` |
| Data query | `ComponentDataQuery` |
| Data source · Operation | `DataSourceDefinition` · `ValueOperation` |
| Comment · Arena (+ Artboard?) · Split | `Comment` · `Arena`/`ArenaFrame` · `Split` |
| Dependency/import · Project | `NpmPackage`/`ImportSpec` · `ProjectPackage` |

## 2. The `Map<value, X>` rule — the coordinate mechanism

A `Map<value, X>` in the model means **"X is addressed BY value, within its owner."** Handle it uniformly:
**elevate the owner to the OBJECT · collapse `X` into the application path · lift the key as an ADDRESSING
COORDINATE.**

| keyed map | object (owner) | X collapses | coordinate (key) |
|---|---|---|---|
| `node.rs: Map<Set<Variant>, RuleSet>` | element | RuleSet | **variance** |
| `node.attrs / eventHandlers / text` | element | AttributesSet / EventHandlersSet / TextSet | **variance** |
| `token.values: Map<Set<Variant>, value>` | token | (the value wrapper) | **variance** ("brand-blue is #f00 in dark mode") |
| `component.frames: Map<Set<Variant>, FrameConfig>` | component | FrameConfig | **variance** |
| `component.overrides: Map<State, CustomCode>` | component | CustomCode | a **State** ("the count override") |
| `ArgsSet.args: Map<State, …>` | (the owner) | — | a **State** |

This reconciles "axis, not path": the key is *always* an addressing coordinate (a subpath) — **variance is the
one whose coordinate is an intent AXIS**, so it renders as a clause ("under danger") rather than a path segment.
It also settles what collapses: **the `X` in every keyed map is application-path *by construction*.**

## 3. Typed variance — the coordinate's kind

The variance coordinate is not opaque — it carries its **kind**, from `VariantGroup.subject`
(`State | Environment | CustomCode`) + `pseudoVariantGroups`. Phrasing (and grouping pressure) dispatch on it:

- **pseudo-state** (hover / focus / pressed) → "**when** {x}" — e.g. *when hovered*
- **environment** (dark mode, breakpoint) → "**in** {x}" — e.g. *in dark mode*
- **component-state** (danger, loading) → "in the {x} **state**" — e.g. *in the danger state*

The interaction-pseudo-state kind is what makes a multi-facet "when hovered" bundle *want* to read as one gesture.

## 4. The two consolidation passes (the middle-end)

- **Pass 1 — birth-cascade collapse** (built): one entity's *creation* (add component = ~16 changes → one
  `ComponentAdded`). The FRESH-membership rule; a node's first styles/handlers fold in here (V's keep-absorbing
  decision — see `consolidate.ts`).
- **Pass 2 — facets-by-(object, coordinate)** (new, to build): after each change resolves to
  `(object, facet, coordinate)`, **group by `(object, coordinate)`** and compose the facets into one sentence:
  > "action button gets additional click handler, pointer cursor, and scale **when hovered**"

  Pass 1 collapses one entity's *birth*; Pass 2 collapses *many facets of one object under one coordinate*. The
  middle-end runs both.

## 5. Variant lifecycle — the dual

*Defining* a variant is a named act (a subject-event): variant/value added to component|site · condition changed ·
precedence changed · combo added to element. *Using* a combo is the coordinate (§2–3). Dual, split exactly at
**define-vs-use**.

## 6. The element mega-object

The element (`TplNode`) absorbs **Styling / Attrs / Behavior / Text / Structure** as *facets* (V: "it indeed
absorbs everything, and it's fair"). Its facet changes are element-events, qualified by the coordinate. The other
objects carry thinner facet vocabularies. Pass 2 is what makes a many-facet element edit read as one human gesture.

## What's NOT whole (open edges — V: "not whole, but closer")

- **Object set** not fully locked — V's core list + "probably more"; data-source / operation / comment / arena /
  split / dependency / project are candidates; palette/font's object-vs-facet status open.
- **Facet vocabularies** per object — to enumerate (the element's are the rich ones).
- **Pass-2 grouping & phrasing by variant-kind** — to design (esp. how multi-axis combos read).
- **Cross-cut net-collapse** (rename A→B→C = one net rename) — still a TODO.
- **More to discover** — the architecture is closer, not whole; keep experimenting.

## Relation to the studio

This *is* the studio's grounding line applied to the log: **objects + coordinates = intent (foreground);
application path = materialization (glass, collapsed).** Same move, one layer up.
