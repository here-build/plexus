import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Styling / RuleSet / layers  (design §1 "Styling / RuleSet / layers", §3 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * A `RuleSet` is the unit of style — held by a `TplNode` in a per-variant-combo map
 * (`TplNode.rs: Map<Set<Variant>, RuleSet>`), or by a `StyleExpr` / a `SelectorRuleSet`.
 * It carries CSS props (`_values`), the layer STACKS (background / shadow / filter /
 * transform / mask) as ordered entity lists, the `Surface` / `EffectsToken` composition
 * children, the transition spec, the motion-keyframes map, and the per-variant override /
 * visibility maps. This area owns EDITS to an existing RuleSet and the layer-entity
 * lifecycle (add / edit / remove / reorder). A brand-new RuleSet's birth — and its
 * constructor-seeded layout-shell CSS (display:flex / position:relative / …) — is
 * ABSORBED by the central pipeline (the FRESH-membership / layout-shell rule), so this
 * module never re-emits a RuleSet birth; it describes what changed AFTER one exists.
 *
 * ── What the LIVE LIFT gives us (verified against core/src/lift.ts + lift.test.ts) ──
 * The lift is AHEAD of intent-lens-hardening.md §1.2/§1.3 here — two kills it raised are
 * already CLOSED in core, so we do NOT degrade to "N properties changed":
 *   - `_values` (a `@syncing.child.record` of CSS props) surfaces PAIRED + KEYED: a value
 *     edit is ONE `set {field:"_values", key:"<css-prop>", before, after}` (C1+C2). A first
 *     write is `set {... after}` (no before); a delete is `clear {field:"_values", key, before}`.
 *     → the CSS prop rides in `change.key`, and we CAN compute a felt delta (before↔after).
 *   - layer LISTS (`shadowLayers` / `backgroundLayers` / `transformLayers` /
 *     `backdropFilterLayers`, + `effects.filters` / `effects.masks` / `surface.*`) are
 *     `@syncing.child.list` of layer ENTITIES. A reorder is ONE `reorder {field:"<list>"}` (C3,
 *     direction-less — no index in the lift yet). A layer ADD is the layer entity `materialized`
 *     under a non-fresh RuleSet/Surface/Effects → reaches `recognizeBirth`. A remove is `detach`.
 *
 * ── Entity types this area OWNS (the `@syncing("…")` nodeName the lift stamps in entity.type;
 *    verified against the model source this pass — RuleSet.ts / Surface.ts / SelectorRuleSet.ts /
 *    *Layer.ts / TransitionSpec.ts / GradientStop.ts / EffectsToken.ts / motion/*.ts) ──
 *   - "RuleSet"        — _values (CSS), transitioningProperties, defaultTransition (child),
 *                        box / textStyle (single-slot token bindings), motions (child.map),
 *                        layerOverrides / layerVisibility (child.map), surface / effects (children)
 *   - "SelectorRuleSet" — a custom `selector` + its nested rs (custom-selector styling)
 *   - "Surface"        — the box-paint composition (extends packs + the three layer lists)
 *   - "EffectsToken"   — opacity / mixBlendMode scalars + filter/mask stacks + extends packs.
 *                        DUAL-USE (RuleSet.effects inline OR a Site-level pack); see boundary note.
 *   - the LAYER entities: "BackgroundLayer" "ShadowLayer" "FilterLayer" "TransformLayer"
 *                         "MaskLayer" "SVGFilterLayer" "GradientStop"
 *   - "TransitionSpec" — duration / easing / delay timing
 *   - "MotionAnimation" / "MotionAnimationRef" — keyframe animation timing (animation aspect)
 *
 * ── Boundary calls (where the cut crosses into a neighbouring area) ──────────
 *   - The *Token WRAPPER entities — "ShadowToken" "GradientToken" "BoxToken" "ColorToken"
 *     "SurfaceToken" "FilterToken" "TransformToken" "MaskToken" "TextStyleToken"
 *     "TypefaceToken" — and the *TokenReference wrappers are the TOKENS & THEME area
 *     (Site-level reusable values). We touch a token only as a BINDING ON a RuleSet
 *     (`box`/`textStyle` set, an `extends`-pack insert) — the "linked to {token}" fact —
 *     never the token's own value. A `GradientStop` is the one borderline: its parent is a
 *     `GradientToken` (Tokens), but per hardening §3.2 its position/color geometry edit is a
 *     LAYER-stack felt-delta we surface here. If the Tokens area later claims GradientStop,
 *     register it BEFORE this one (see registry-ordering note).
 *   - `EffectsToken` / `SurfaceToken` / `ShadowToken` are dual-parent (a RuleSet/Surface child
 *     = ours, a Site child = Tokens). `entity.type` can't disambiguate from the change alone;
 *     the inline-on-a-RuleSet case is the common styling gesture, so we claim EffectsToken
 *     scalar/list/pack EDITS and flag the Site-pack overlap (registry-ordering note).
 *   - `ruleRepresentationPreference` (a studio-only visual-grouping hint, ZERO emitted-CSS
 *     effect — hardening §3.2) → consciously DROP (returned null → central salience drop / RawEdit).
 *   - `colorExpr` on a ShadowLayer/GradientStop is a CustomCode child (a token pointer / expr);
 *     its body is the Behavior/Expression area. We surface only that the color went dynamic.
 *   - `layerOverrides` is keyed by an entity-tuple (`[Layer, field]`, hardening §1.3 case 2);
 *     the lift's `key` is the serialized tuple, not deref'd → coarse "a per-variant override"
 *     (consciously partial, below).
 */

// ── Entity-type sets ─────────────────────────────────────────────────────────
// Layer entities that live in a RuleSet/Surface/EffectsToken stack list.
const LAYER_TYPES = new Set([
  "BackgroundLayer",
  "ShadowLayer",
  "FilterLayer",
  "TransformLayer",
  "MaskLayer",
  "SVGFilterLayer",
]);
const isLayer = (t: string): boolean => LAYER_TYPES.has(t);

// The RuleSet-level layer list fields (for reorder routing + birth attribution).
const LAYER_LIST_FIELDS = new Set([
  "backgroundLayers",
  "shadowLayers",
  "transformLayers",
  "backdropFilterLayers",
  "filters", // EffectsToken.filters
  "masks", // EffectsToken.masks
  "shadows", // Surface.shadows
  "backgrounds", // Surface.backgrounds
  "backdropFilters", // Surface.backdropFilters
]);

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
const name = (ctx: LensCtx, uuid: string, seq: number): string | undefined => ctx.nameOf(uuid, seq);

/** The owning node/component name (resolved via the owner walk), for "On {target}". */
function target(ctx: LensCtx, uuid: string, seq: number): string | undefined {
  if (!ctx.ownerOf) return undefined;
  const o = ctx.ownerOf(uuid, seq);
  return o ? name(ctx, o, seq) : undefined;
}

/** A layer entity's human noun (its `entity.type`). DRAFT — V review (wording). */
function layerNoun(t: string): string {
  switch (t) {
    case "BackgroundLayer":
      return "background"; // DRAFT — V review
    case "ShadowLayer":
      return "shadow"; // DRAFT — V review
    case "FilterLayer":
      return "filter"; // DRAFT — V review
    case "TransformLayer":
      return "transform"; // DRAFT — V review
    case "MaskLayer":
      return "mask"; // DRAFT — V review
    case "SVGFilterLayer":
      return "SVG filter"; // DRAFT — V review
    default:
      return "layer";
  }
}

/**
 * The human concept for a CSS property key (the lens CSS lexicon — design §3.1 `cssPropConcept`).
 * A STARTER table: the common cases read as a felt concept ("left padding"), the long tail
 * degrades to the de-hyphenated property name (always domain-safe, never a raw `padding-left`
 * leak unless that IS the clearest reading). `--studio-*` / `--ir-*` markers are intent supersets
 * (design §3.1 `markerConcept`) — handled separately below. DRAFT — V review (the lexicon).
 */
const CSS_CONCEPT: Record<string, string> = {
  "padding-left": "left padding",
  "padding-right": "right padding",
  "padding-top": "top padding",
  "padding-bottom": "bottom padding",
  "margin-left": "left margin",
  "margin-right": "right margin",
  "margin-top": "top margin",
  "margin-bottom": "bottom margin",
  "font-size": "text size",
  "font-weight": "text weight",
  "line-height": "line height",
  "background-color": "background",
  color: "text color",
  "border-radius": "corner radius",
  width: "width",
  height: "height",
  opacity: "opacity",
  gap: "gap",
};

/** A CSS prop key → human concept. Marker keys (`--herebuild-*`/`--studio-*`/`--ir-*`) phrase via `markerConcept`. */
function cssPropConcept(key: string): string {
  if (key.startsWith("--herebuild-") || key.startsWith("--studio-") || key.startsWith("--ir-")) return markerConcept(key);
  return CSS_CONCEPT[key] ?? deHyphen(key); // DRAFT — V review (long-tail fallback)
}

/** `--herebuild-intent-sizing-width-mode` → "width sizing"; default strips the prefix + de-hyphenates (degrade-safe). */
function markerConcept(key: string): string {
  const bare = key.replace(/^--(herebuild-rule|herebuild-intent|studio|ir)-/, "");
  return deHyphen(bare); // DRAFT — V review (a named-marker table can refine this)
}

const deHyphen = (k: string): string => k.replace(/^--/, "").replaceAll("-", " ");

/**
 * A felt dimension delta (design §3 first law: "2px wider", "8px more"). Only fires when both
 * before/after parse as a single `<number><unit>` of the SAME unit; otherwise reads as the raw
 * "X → Y" (still a state, never a bare number). DRAFT — V review (the felt wording).
 */
function valueDelta(before: unknown, after: unknown): string {
  const b = parseDim(before);
  const a = parseDim(after);
  if (b && a && b.unit === a.unit) {
    const d = a.n - b.n;
    if (d === 0) return `set to ${str(after)}`;
    const mag = `${Math.abs(d)}${a.unit}`;
    return d > 0 ? `${mag} more` : `${mag} less`; // DRAFT — V review (per-prop "wider/taller/tighter" later)
  }
  if (before === undefined) return `set to ${str(after)}`;
  return `${str(before)} → ${str(after)}`;
}

function parseDim(v: unknown): { n: number; unit: string } | null {
  if (typeof v !== "string") return null;
  const m = /^(-?\d*\.?\d+)(px|rem|em|%|vh|vw|deg)$/.exec(v.trim());
  return m ? { n: Number(m[1]), unit: m[2] } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent-kind TYPES (design §1 "Styling / RuleSet / layers" block)
// ─────────────────────────────────────────────────────────────────────────────

/** A CSS property value was set / changed / cleared on a RuleSet (the `_values` record, key-bearing). */
export interface StylePropertyChanged extends IntentEventBase {
  kind: "StylePropertyChanged";
  /** the owning node/component (resolved via the owner walk; undefined if unrecovered). */
  targetLabel?: string;
  /** the CSS property as a human concept (`cssPropConcept(key)`). */
  propConcept: string;
  /** set | changed | cleared (cleared = the prop deleted, falls back through the cascade). */
  op: "set" | "changed" | "cleared";
  /** a felt delta ("2px more") or "set to {value}" / "{before} → {after}". Absent for cleared. */
  delta?: string;
}

/** A CSS property's value was bound to an expression (CustomCode) — it became dynamic. */
export interface StyleExpressionBound extends IntentEventBase {
  kind: "StyleExpressionBound";
  targetLabel?: string;
  propConcept: string;
  /** bound — now driven by an expression; unbound — back to a static value. */
  bound: boolean;
}

/** A layer was added to / removed from a RuleSet/Surface/Effects stack (background/shadow/filter/…). */
export interface LayerChanged extends IntentEventBase {
  kind: "LayerChanged";
  targetLabel?: string;
  /** the layer kind noun (`layerNoun(entity.type)`). */
  layer: string;
  op: "added" | "removed" | "edited" | "reordered";
  /** for edited: the felt field delta ("blur 8px → 12px") or the field concept; else absent. */
  detail?: string;
}

/** A transition spec changed (`defaultTransition` timing, or a `transitioningProperties` toggle). */
export interface TransitionChanged extends IntentEventBase {
  kind: "TransitionChanged";
  targetLabel?: string;
  op: "added" | "changed" | "removed" | "propertyToggled";
  /** the duration/easing/delta phrase (timing) or the toggled CSS prop concept. */
  detail?: string;
}

/** A keyframe animation changed (MotionAnimation timing, or a `motions`-map entry added/removed). */
export interface MotionChanged extends IntentEventBase {
  kind: "MotionChanged";
  targetLabel?: string;
  op: "added" | "changed" | "removed";
  /** the duration/easing/iteration phrase, or absent. */
  detail?: string;
}

/** Opacity or blend-mode (the EffectsToken scalars) changed. */
export interface EffectsScalarChanged extends IntentEventBase {
  kind: "EffectsScalarChanged";
  targetLabel?: string;
  /** opacity | blend — which scalar. */
  scalar: "opacity" | "blend";
  /** the value delta / state. */
  detail: string;
}

/** A reusable pack reference was added/removed on a RuleSet's Surface / Effects (`extends`). */
export interface SurfaceTokensChanged extends IntentEventBase {
  kind: "SurfaceTokensChanged";
  targetLabel?: string;
  /** surface | effects — which composition the pack joined. */
  pack: "surface" | "effects";
  op: "added" | "removed";
  /** the pack token name (resolved if present; else "a pack"). */
  tokenName?: string;
}

/** A box recipe or text style was bound to / cleared from a RuleSet (`box` / `textStyle`). */
export interface BoxRecipeChanged extends IntentEventBase {
  kind: "BoxRecipeChanged";
  targetLabel?: string;
  /** box — the BoxToken (border/padding/radius/clip); textStyle — the TextStyleToken. */
  what: "box" | "textStyle";
  op: "set" | "cleared";
  /** the bound token's name (resolved if present; else absent). */
  tokenName?: string;
}

/** A custom CSS selector was set / cleared on a SelectorRuleSet. */
export interface SelectorChanged extends IntentEventBase {
  kind: "SelectorChanged";
  targetLabel?: string;
  op: "set" | "cleared";
  /** the selector text (set) or absent (cleared). */
  selector?: string;
}

/** A per-variant layer override or layer-visibility toggle changed (the hypergraph maps). */
export interface LayerOverrideChanged extends IntentEventBase {
  kind: "LayerOverrideChanged";
  targetLabel?: string;
  /** override — a per-variant field override (coarse, entity-tuple key not deref'd);
   *  visibility — a per-stack layer hidden/shown. */
  what: "override" | "visibility";
  /** for visibility: the new shown/hidden state. */
  shown?: boolean;
}

/** Every intent kind the Styling area owns. */
export type StylingIntent =
  | StylePropertyChanged
  | StyleExpressionBound
  | LayerChanged
  | TransitionChanged
  | MotionChanged
  | EffectsScalarChanged
  | SurfaceTokensChanged
  | BoxRecipeChanged
  | SelectorChanged
  | LayerOverrideChanged;

// ─────────────────────────────────────────────────────────────────────────────
// The area module
// ─────────────────────────────────────────────────────────────────────────────

export const stylingArea: AreaModule = {
  name: "Styling/RuleSet/layers",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): StylingIntent | null {
    const t = root.entity.type;
    const u = root.entity.uuid;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

    // A fresh LAYER entity under a NON-fresh RuleSet/Surface/Effects = a layer added to an
    // existing stack (hardening §1.7 "fresh child of a non-fresh parent"). Its scalar payload
    // (x/y/blur/kind/params) is birth-merged by the pipeline → we surface just the add.
    // (A layer born WITH a fresh RuleSet is that RuleSet's birth payload → absorbed centrally,
    // never reaches us — RuleSet births and their seeds are absorbed at birth.)
    if (isLayer(t)) {
      return {
        kind: "LayerChanged",
        ...(target(ctx, u, meta.seq) !== undefined ? { targetLabel: target(ctx, u, meta.seq) } : {}),
        layer: layerNoun(t),
        op: "added",
        ...base,
      };
    }

    // A fresh TransitionSpec under a non-fresh RuleSet = a transition was added.
    // (`defaultTransition` is a `@syncing.child` single slot; under a fresh RuleSet → absorbed.)
    if (t === "TransitionSpec") {
      return {
        kind: "TransitionChanged",
        ...(target(ctx, u, meta.seq) !== undefined ? { targetLabel: target(ctx, u, meta.seq) } : {}),
        op: "added",
        ...base,
      };
    }

    // A fresh MotionAnimation / MotionAnimationRef = an animation was added to the element.
    // (MotionAnimation is parented by the TplNode; the Ref is the RuleSet.motions map entry.)
    if (t === "MotionAnimation" || t === "MotionAnimationRef") {
      return {
        kind: "MotionChanged",
        ...(target(ctx, u, meta.seq) !== undefined ? { targetLabel: target(ctx, u, meta.seq) } : {}),
        op: "added",
        ...base,
      };
    }

    // A fresh SelectorRuleSet = a custom-selector style block was added. Its `selector` string
    // rides in a birth-merged set we don't see; surface the add with an unknown selector.
    if (t === "SelectorRuleSet") {
      return {
        kind: "SelectorChanged",
        ...(target(ctx, u, meta.seq) !== undefined ? { targetLabel: target(ctx, u, meta.seq) } : {}),
        op: "set",
        ...base,
      };
    }

    // NB: a fresh "RuleSet" / "Surface" / "EffectsToken" is NOT emitted here — a new RuleSet
    // (a new variant combo's styling) + its eager Surface/Effects + its seed CSS are absorbed
    // by the central pipeline as a birth cluster. We describe edits to them, not their birth.
    return null;
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): StylingIntent | null {
    const t = c.entity.type;
    const u = c.entity.uuid;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };
    const tgt = target(ctx, u, meta.seq);
    const withTgt = tgt !== undefined ? { targetLabel: tgt } : {};

    // ── RuleSet edits ─────────────────────────────────────────────────────────
    if (t === "RuleSet") {
      // CSS property value (the `_values` record, key = the CSS prop). The lift PAIRS + KEYS
      // these (C1+C2): a `set` carries {key, before?, after}; a `clear` carries {key, before}.
      if (c.field === "_values" && c.key !== undefined) {
        // A CustomCode value (an expression binding) → StyleExpressionBound, not a felt delta.
        if (isExprValue(c.after) || (c.verb === "clear" && isExprValue(c.before))) {
          return {
            kind: "StyleExpressionBound",
            ...withTgt,
            propConcept: cssPropConcept(c.key),
            bound: c.verb !== "clear" && isExprValue(c.after),
            ...base,
          };
        }
        if (c.verb === "clear") {
          return { kind: "StylePropertyChanged", ...withTgt, propConcept: cssPropConcept(c.key), op: "cleared", ...base };
        }
        if (c.verb === "set") {
          const op = c.before === undefined ? "set" : "changed";
          return {
            kind: "StylePropertyChanged",
            ...withTgt,
            propConcept: cssPropConcept(c.key),
            op,
            delta: valueDelta(c.before, c.after),
            ...base,
          };
        }
      }

      // `ruleRepresentationPreference` — a studio-only visual-grouping hint, zero emitted-CSS
      // effect (hardening §3.2). Consciously DROP → null (the central salience drop / RawEdit).
      if (c.field === "ruleRepresentationPreference") return null;

      // `box` / `textStyle` — single-slot token bindings. set (after present) = bound;
      // clear / set-null = unbound. The token name lives in `after` as a ref (unlabeled by
      // decorate, hardening §4.3#4); surface coarsely (resolveName-over-after is deferred).
      if (c.field === "box" || c.field === "textStyle") {
        const cleared = c.verb === "clear" || c.after == null;
        return {
          kind: "BoxRecipeChanged",
          ...withTgt,
          what: c.field === "box" ? "box" : "textStyle",
          op: cleared ? "cleared" : "set",
          ...base,
        };
      }

      // `transitioningProperties` — a `@syncing.child.record` (key = the CSS prop a transition
      // applies to). A keyed set/clear toggles which property transitions.
      if (c.field === "transitioningProperties" && c.key !== undefined) {
        return {
          kind: "TransitionChanged",
          ...withTgt,
          op: "propertyToggled",
          detail: cssPropConcept(c.key),
          ...base,
        };
      }

      // `layerVisibility` — a `@syncing.child.map` (entity-keyed) per-stack on/off toggle.
      if (c.field === "layerVisibility") {
        const shown = c.verb === "clear" ? true : c.after !== false;
        return { kind: "LayerOverrideChanged", ...withTgt, what: "visibility", shown, ...base };
      }

      // `layerOverrides` — a `@syncing.child.map` keyed by an entity-tuple ([Layer, field]).
      // The lift's `key` is the serialized tuple (not deref'd, hardening §1.3 case 2) → coarse.
      if (c.field === "layerOverrides") {
        return { kind: "LayerOverrideChanged", ...withTgt, what: "override", ...base };
      }

      // A layer-LIST reorder (C3 direction-less) — `field` = the reordered stack list.
      if (c.verb === "reorder" && c.field !== undefined && LAYER_LIST_FIELDS.has(c.field)) {
        return { kind: "LayerChanged", ...withTgt, layer: listToLayerNoun(c.field), op: "reordered", ...base };
      }
    }

    // ── EffectsToken (inline RuleSet.effects — see boundary note) ──────────────
    if (t === "EffectsToken") {
      if (c.field === "opacity" && (c.verb === "set" || c.verb === "clear")) {
        return {
          kind: "EffectsScalarChanged",
          ...withTgt,
          scalar: "opacity",
          detail: c.verb === "clear" ? "reset" : valueDelta(c.before, c.after),
          ...base,
        };
      }
      if (c.field === "mixBlendMode" && (c.verb === "set" || c.verb === "clear")) {
        return {
          kind: "EffectsScalarChanged",
          ...withTgt,
          scalar: "blend",
          detail: c.verb === "clear" ? "normal" : str(c.after),
          ...base,
        };
      }
      // `extends` — a Site-level EffectsToken pack joined/left this element's effects.
      if (c.field === "extends" && (c.verb === "insert" || c.verb === "remove")) {
        const refUuid = pickRefUuid(c.verb === "insert" ? c.after : c.before);
        return {
          kind: "SurfaceTokensChanged",
          ...withTgt,
          pack: "effects",
          op: c.verb === "insert" ? "added" : "removed",
          ...(refUuid && name(ctx, refUuid, meta.seq) ? { tokenName: name(ctx, refUuid, meta.seq) } : {}),
          ...base,
        };
      }
      // A reorder of the effects filter/mask stacks (C3).
      if (c.verb === "reorder" && (c.field === "filters" || c.field === "masks")) {
        return { kind: "LayerChanged", ...withTgt, layer: listToLayerNoun(c.field), op: "reordered", ...base };
      }
    }

    // ── Surface (the box-paint composition `extends` packs) ─────────────────────
    if (t === "Surface") {
      if (c.field === "extends" && (c.verb === "insert" || c.verb === "remove")) {
        const refUuid = pickRefUuid(c.verb === "insert" ? c.after : c.before);
        return {
          kind: "SurfaceTokensChanged",
          ...withTgt,
          pack: "surface",
          op: c.verb === "insert" ? "added" : "removed",
          ...(refUuid && name(ctx, refUuid, meta.seq) ? { tokenName: name(ctx, refUuid, meta.seq) } : {}),
          ...base,
        };
      }
      if (c.verb === "reorder" && c.field !== undefined && LAYER_LIST_FIELDS.has(c.field)) {
        return { kind: "LayerChanged", ...withTgt, layer: listToLayerNoun(c.field), op: "reordered", ...base };
      }
    }

    // ── Layer-entity edits + removal ───────────────────────────────────────────
    if (isLayer(t)) {
      // detach = removed from its stack. (No `from` name needed — the stack lives on the RuleSet;
      // owner-walk gives the target node.)
      if (c.verb === "detach") {
        return { kind: "LayerChanged", ...withTgt, layer: layerNoun(t), op: "removed", ...base };
      }
      // A scalar field edit on a layer. ShadowLayer geometry (x/y/blur/spread) is attribute-paired
      // → a felt delta (hardening §5.1 "attribute-backed felt-deltas"). `params` (FilterLayer/
      // TransformLayer) is a `@syncing.map` (keyed) — surface the param concept; `kind` flips the
      // layer's role. `color`/`image`/`size`/… read as the field concept.
      if (c.verb === "set" || c.verb === "clear") {
        const detail = layerFieldDetail(c);
        return {
          kind: "LayerChanged",
          ...withTgt,
          layer: layerNoun(t),
          op: "edited",
          ...(detail !== undefined ? { detail } : {}),
          ...base,
        };
      }
    }

    // ── GradientStop (a gradient color stop — layer-stack geometry, hardening §3.2) ──
    if (t === "GradientStop") {
      if (c.verb === "detach") {
        return { kind: "LayerChanged", ...withTgt, layer: "gradient stop", op: "removed", ...base };
      }
      if (c.verb === "set" || c.verb === "clear") {
        // position is a number (% along the gradient); color is a string. Felt where possible.
        const detail =
          c.field === "position"
            ? `stop at ${str(c.after)}%`
            : c.field === "color"
              ? `color → ${str(c.after)}`
              : deHyphen(c.field ?? "");
        return { kind: "LayerChanged", ...withTgt, layer: "gradient stop", op: "edited", detail, ...base };
      }
    }

    // ── TransitionSpec edits / removal ──────────────────────────────────────────
    if (t === "TransitionSpec") {
      if (c.verb === "detach") {
        return { kind: "TransitionChanged", ...withTgt, op: "removed", ...base };
      }
      if ((c.field === "duration" || c.field === "easing" || c.field === "delay") && (c.verb === "set" || c.verb === "clear")) {
        // easingHint is the compile-erased authoring superset (TransitionSpec.ts) → not a user
        // intent on its own; only duration/easing/delay are the real timing edits.
        return { kind: "TransitionChanged", ...withTgt, op: "changed", detail: transitionDetail(c), ...base };
      }
      // easingHint → consciously DROP (superset marker, no emitted-CSS effect of its own).
      if (c.field === "easingHint") return null;
    }

    // ── MotionAnimation edits / removal ─────────────────────────────────────────
    if (t === "MotionAnimation") {
      if (c.verb === "detach") {
        return { kind: "MotionChanged", ...withTgt, op: "removed", ...base };
      }
      if (c.verb === "set" || c.verb === "clear") {
        return { kind: "MotionChanged", ...withTgt, op: "changed", detail: deHyphen(c.field ?? ""), ...base };
      }
    }
    // A `motions`-map entry on the RuleSet removed (a keyframe track detached) — the Ref detach.
    if (t === "MotionAnimationRef" && c.verb === "detach") {
      return { kind: "MotionChanged", ...withTgt, op: "removed", ...base };
    }

    // ── SelectorRuleSet.selector edit / removal ─────────────────────────────────
    if (t === "SelectorRuleSet") {
      if (c.verb === "detach") {
        return { kind: "SelectorChanged", ...withTgt, op: "cleared", ...base };
      }
      if (c.field === "selector" && (c.verb === "set" || c.verb === "clear")) {
        const cleared = c.verb === "clear" || c.after == null;
        return {
          kind: "SelectorChanged",
          ...withTgt,
          op: cleared ? "cleared" : "set",
          ...(cleared ? {} : { selector: str(c.after) }),
          ...base,
        };
      }
    }

    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "StylePropertyChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        if (e.op === "cleared") return `${on}cleared ${e.propConcept}`; // DRAFT — V review
        return `${on}${e.propConcept} ${e.delta ?? ""}`.trimEnd(); // DRAFT — V review
      }
      case "StyleExpressionBound": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        return e.bound
          ? `${on}${e.propConcept} is now bound to an expression` // DRAFT — V review
          : `${on}${e.propConcept} is no longer dynamic`; // DRAFT — V review
      }
      case "LayerChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        if (e.op === "added") return `${on}added a ${e.layer}`; // DRAFT — V review
        if (e.op === "removed") return `${on}removed a ${e.layer}`; // DRAFT — V review
        if (e.op === "reordered") return `${on}reordered the ${e.layer} stack`; // DRAFT — V review
        return `${on}${e.layer}: ${e.detail ?? "edited"}`; // DRAFT — V review (edited)
      }
      case "TransitionChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        if (e.op === "added") return `${on}added a transition`; // DRAFT — V review
        if (e.op === "removed") return `${on}removed the transition`; // DRAFT — V review
        if (e.op === "propertyToggled") return `${on}now transitions ${e.detail ?? "a property"}`; // DRAFT — V review
        return `${on}transition ${e.detail ?? "changed"}`; // DRAFT — V review
      }
      case "MotionChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        if (e.op === "added") return `${on}added an animation`; // DRAFT — V review
        if (e.op === "removed") return `${on}removed an animation`; // DRAFT — V review
        return `${on}animation ${e.detail ?? "changed"}`; // DRAFT — V review
      }
      case "EffectsScalarChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        return e.scalar === "opacity"
          ? `${on}opacity ${e.detail}` // DRAFT — V review
          : `${on}blend mode → ${e.detail}`; // DRAFT — V review
      }
      case "SurfaceTokensChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        const pack = e.pack === "surface" ? "surface" : "effects";
        const named = e.tokenName ? ` "${e.tokenName}"` : "";
        return e.op === "added"
          ? `${on}added the${named} ${pack} pack` // DRAFT — V review
          : `${on}removed the${named} ${pack} pack`; // DRAFT — V review
      }
      case "BoxRecipeChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        const what = e.what === "box" ? "box recipe" : "text style";
        if (e.op === "cleared") return `${on}removed the ${what}`; // DRAFT — V review
        return e.tokenName ? `${on}${what} → "${e.tokenName}"` : `${on}set the ${what}`; // DRAFT — V review
      }
      case "SelectorChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        if (e.op === "cleared") return `${on}removed the custom selector`; // DRAFT — V review
        return e.selector ? `${on}targets ${e.selector}` : `${on}added a custom selector`; // DRAFT — V review
      }
      case "LayerOverrideChanged": {
        const on = e.targetLabel ? `On ${e.targetLabel}: ` : "";
        if (e.what === "visibility") {
          return e.shown ? `${on}showed a layer (this variant)` : `${on}hid a layer (this variant)`; // DRAFT — V review
        }
        return `${on}changed a per-variant layer override`; // DRAFT — V review
      }
      default:
        return null;
    }
  },

  // Pass-2 fragment (lens-architecture.md §4/§6): the bare facet phrase the composer joins under
  // "{element} gets … {coordinate}". An ADDITIVE acquisition (a property set, a layer/transition/animation
  // added, a pack/recipe/selector bound) reads as a NOUN — matching §4's flagship ("pointer cursor", "scale").
  // The VALUE/delta stays in the per-event `humanize` drill-down; the grouped gesture names WHICH facets moved.
  // A non-additive edit (cleared / removed / reordered / a scalar tweak / a per-variant override) returns
  // `null` → it renders as a standalone `humanize` line (the Pass-2 verb model is the named open edge). DRAFT.
  fragment(e): string | null {
    switch (e.kind) {
      case "StylePropertyChanged":
        return e.op === "cleared" ? null : e.propConcept; // DRAFT — "background" / "corner radius" / "cursor"
      case "StyleExpressionBound":
        return e.bound ? `dynamic ${e.propConcept}` : null; // DRAFT — unbinding is non-additive
      case "LayerChanged":
        return e.op === "added" ? `a ${e.layer}` : null; // DRAFT — "a shadow"; edited/removed/reordered standalone
      case "TransitionChanged":
        return e.op === "added" ? "a transition" : null; // DRAFT
      case "MotionChanged":
        return e.op === "added" ? "an animation" : null; // DRAFT
      case "SurfaceTokensChanged":
        return e.op === "added" ? `the ${e.tokenName ? `"${e.tokenName}" ` : ""}${e.pack} pack` : null; // DRAFT
      case "BoxRecipeChanged":
        return e.op === "set" ? (e.what === "box" ? "a box recipe" : "a text style") : null; // DRAFT
      case "SelectorChanged":
        return e.op === "set" ? "a custom selector" : null; // DRAFT
      // EffectsScalarChanged (a value tweak) + LayerOverrideChanged (a per-variant edit) are non-additive → standalone.
      default:
        return null;
    }
  },
};

// ── local helpers ──────────────────────────────────────────────────────────

/** A `_values` / scalar value is an expression binding if it's a CustomCode-shaped ref, not a string. */
function isExprValue(v: unknown): boolean {
  // CustomCode serializes as a non-string object/ref in before/after; a plain CSS value is a string.
  return v != null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean";
}

/** Pull a single uuid out of a child-list element value (bare string or `[uuid]` tuple). */
function pickRefUuid(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/** A layer-list FIELD name → the layer noun for its stack. DRAFT — V review. */
function listToLayerNoun(field: string): string {
  switch (field) {
    case "backgroundLayers":
    case "backgrounds":
      return "background"; // DRAFT — V review
    case "shadowLayers":
    case "shadows":
      return "shadow"; // DRAFT — V review
    case "transformLayers":
      return "transform"; // DRAFT — V review
    case "backdropFilterLayers":
    case "backdropFilters":
    case "filters":
      return "filter"; // DRAFT — V review
    case "masks":
      return "mask"; // DRAFT — V review
    default:
      return "layer";
  }
}

/** A felt detail for a layer scalar/param edit. ShadowLayer geometry → felt delta; params → concept. */
function layerFieldDetail(c: PlexusChange): string | undefined {
  const f = c.field;
  if (f === undefined) return undefined;
  // ShadowLayer x/y/blur/spread are attribute-paired dimensions → felt delta.
  if (f === "blur" || f === "spread" || f === "x" || f === "y") return `${deHyphen(f)} ${valueDelta(c.before, c.after)}`;
  if (f === "inset") return c.after === true ? "now inset" : "no longer inset"; // DRAFT — V review
  if (f === "color") return `color → ${str(c.after)}`; // DRAFT — V review
  // FilterLayer/TransformLayer `params` is a keyed map — the param name rides in `key`.
  if (f === "params" && c.key !== undefined) return `${c.key} ${valueDelta(c.before, c.after)}`;
  if (f === "kind") return `kind → ${str(c.after)}`; // DRAFT — V review
  if (f === "image") return "image changed"; // DRAFT — V review (ref in after, unlabeled — §4.3#4)
  return deHyphen(f); // size/position/repeat/clip/origin/attachment/blendMode/mode/composite
}

/** A transition timing detail (duration/easing/delay). DRAFT — V review (felt wording). */
function transitionDetail(c: PlexusChange): string {
  if (c.field === "duration") return `duration ${valueDelta(c.before, c.after)}`;
  if (c.field === "delay") return `delay ${valueDelta(c.before, c.after)}`;
  return `easing → ${str(c.after)}`; // easing
}
