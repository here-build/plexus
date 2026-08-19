import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Tokens & Theme   (design §1 "Tokens & Theme", §3 rows; hardening §1.2/§1.3
 * record-pairing + map-key, §2.2 raw-value leaks, §2.3 conflation splits, §3.2 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * The Site-level design-system library: every reusable token, the palette
 * recipe/application split, fonts, image assets, and the by-tag theme floor.
 *
 * ── What this area OWNS (the `@syncing("…")` nodeName the lift stamps in
 *    `entity.type`; VERIFIED against the model source this pass, see file refs):
 *
 *   Scalar/value tokens (parent = Site):
 *     - "StyleToken"   (global/StyleToken.ts)     — legacy unified, `values` keyed by combo
 *     - "ColorToken"   (styles/ColorToken.ts)     — `values` keyed by combo
 *     - "GradientToken"(styles/GradientToken.ts)  — geometry scalars + `stops` child.list
 *   Composite tokens (parent = Site; `extends` same-kind list; `name: string|null`):
 *     - "ShadowToken" "BoxToken" "SurfaceToken" "TypefaceToken" "EffectsToken"
 *       "TextStyleToken" "FilterToken" "MaskToken" "TransformToken"
 *   Flat-value composites carry a record/map of CSS props:
 *     - BoxToken.values / TypefaceToken.values  = `@syncing.child.record` (→ Y.Map,
 *       PAIRED+KEYED in the lift; `key` = the CSS prop)
 *     - TextStyleToken.values = `@syncing.child.map` of `TextStyleCell` ENTITIES
 *       (keyed by combo; the cell materializes — its birth MERGEs into the token)
 *   Palette (split per hardening §2.3 — application vs recipe, different blast radius):
 *     - "ColorPalette"  (an application: function × base)
 *     - "PaletteFunction" + "PaletteFunctionStep" (the shared recipe; editing a step
 *       fans out to every application)
 *     - "PaletteToken" is DERIVED (virtual genesis from function×base) → never authored,
 *       DROP (falls to the pipeline's genesis/RawEdit handling — we do NOT own it)
 *   Fonts & assets (parent = Site):
 *     - "CustomFont" (+ "StaticFontFile"/"VariableFontFile" children that MERGE)
 *     - "ImageAsset"
 *     - Site.userManagedFonts = `@syncing.set<string>` (web-font family names; the
 *       value IS the human label — no key-loss, no deref)
 *   Theme floor:
 *     - "ElementDefault" (Site.elementDefaults `@syncing.child.record`, keyed by tag;
 *       picks one composite-token pack per channel as a tag's ambient default)
 *
 * ── Lift capabilities this area RELIES ON (VERIFIED in core/src/lift.ts + lift.test.ts,
 *    which have moved PAST the hardening doc's three blocking gaps for OUR cases):
 *   - `change.key` IS populated for Y.Map/record entries (lift.ts:55,104,123,147;
 *     proven lift.test.ts:120 `set field:"attrs" key:"data-x"`). StyleToken/ColorToken
 *     `values` (`@syncing.map`) and BoxToken/TypefaceToken `values`
 *     (`@syncing.child.record`) both back to Y.Map → `verb:"set", field:"values",
 *     key:<entry>`. The hardening §1.3 "string inner key lost" is RESOLVED for us.
 *   - Map entries are PAIRED (lift.ts:103-105 groups attr AND map; lift.test.ts:123
 *     `set before:"v1" after:"v2"`). The hardening §1.2 "record edits indistinguishable
 *     from births" is RESOLVED → a token value EDIT is one `set {key,before,after}` →
 *     felt-deltas ARE computable. (Hardening was written before this landed.)
 *   - A real `reorder` verb IS emitted (lift.ts:159; lift.test.ts:101) for a Y.Array
 *     same-value move → `extends` (`@syncing.list`) reorder surfaces as `verb:"reorder"`.
 *
 * ── KEY SHAPES we still cannot fully resolve (HONEST, → DRAFT/RawEdit, see recognizers):
 *   - Combo key (`StyleToken.values`/`ColorToken.values`/`TextStyleToken.values`/
 *     `PaletteFunctionStep.derivations`) is a `Set<VariantString>` serialized as
 *     `Set\n<jsonTupleLine>\n…` (key-serialization.ts:154; token-variance.ts serde).
 *     We CAN parse the empty-combo (`"Set"` / `""` → base) and best-effort the
 *     discrete-media/pseudo members for a DRAFT combo label, but cross-doc the lens
 *     has no resolver context — we keep the combo phrasing best-effort + DRAFT.
 *   - Alias target: `StyleToken.values` value may be a `CustomCode` pointer (object in
 *     `after`, unlabeled — hardening §2.2) or a legacy `var(--token-<uuid>)` string.
 *     We DETECT alias-vs-literal and phrase generically; the *target token name* needs
 *     the §4.3.4 deref-pass (lens-side archive read) we don't have here → DRAFT.
 *   - Font `featureLabels`/`axisLabels` are SCALAR JSON-string attrs (a SECOND key-loss
 *     class, hardening §2.2) — per-tag delta unrecoverable from one scalar set → we
 *     phrase "relabeled a feature/axis", no specific tag.
 *   - `ElementDefault` tag is the record KEY (hardening §2.4 ⚠key). We surface the
 *     CHANNEL (the changed field) + best-effort the owning Site; the specific tag rides
 *     in the container key which is the record's own field here — left generic.
 *
 * ── Boundary calls (cuts crossing into neighbouring areas):
 *   - Per-USE-SITE token overrides (`RuleSet.layerOverrides`, `RuleSet.box`/`textStyle`
 *     refs, `RuleSet._values` CSS) are STYLING-area, not Tokens. We own the TOKEN
 *     ENTITY's own fields only.
 *   - Layer-stack edits INSIDE a token (ShadowLayer blur, GradientStop position,
 *     BackgroundLayer in a SurfaceToken) are owned by the Styling area's LayerChanged
 *     (hardening §2.3 cross-area dedupe: "pick the Site-level token owner"). We MERGE a
 *     fresh layer child into the token BIRTH, but a layer EDIT on an existing token's
 *     layer we DEFER (→ null → Styling/RawEdit) to avoid double-emission.
 *   - PaletteToken (derived) we do NOT own (genesis/virtual).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Model tables (VERIFIED against model source — Site.ts field names, @syncing names)
// ─────────────────────────────────────────────────────────────────────────────

// Per-class human noun (design §3.1 `tokenNoun`, hardening §2.3 "12-entry table").
// DRAFT — V review (wording). Keys are the `@syncing("…")` names the lift emits.
const TOKEN_NOUN: Record<string, string> = {
  StyleToken: "token",
  ColorToken: "color token",
  GradientToken: "gradient",
  ShadowToken: "shadow token",
  BoxToken: "box recipe",
  SurfaceToken: "surface pack",
  TypefaceToken: "typeface",
  EffectsToken: "effects pack",
  TextStyleToken: "text style",
  FilterToken: "filter pack",
  MaskToken: "mask pack",
  TransformToken: "transform pack",
};
const TOKEN_TYPES = new Set(Object.keys(TOKEN_NOUN));
const isTokenType = (t: string): boolean => TOKEN_TYPES.has(t);
const tokenNoun = (t: string): string => TOKEN_NOUN[t] ?? "token";

// StyleToken.type → friendly value-kind noun (design §3 TokenCreated "{tokenNoun}").
// DRAFT — V review.
const STYLE_TOKEN_KIND: Record<string, string> = {
  Color: "color",
  Spacing: "spacing",
  Opacity: "opacity",
  LineHeight: "line-height",
  FontFamily: "font-family",
  FontSize: "font-size",
  BoxShadow: "shadow",
};

// Composite tokens whose flat `values` is a `@syncing.child.record` of CSS props
// (→ Y.Map → keyed+paired `set field:"values" key:<cssprop>`).
const RECORD_VALUE_TOKENS = new Set(["BoxToken", "TypefaceToken"]);
// Tokens whose `values` is a combo-keyed `@syncing.map` of scalar value | CustomCode.
const COMBO_VALUE_TOKENS = new Set(["StyleToken", "ColorToken"]);

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
const name = (ctx: LensCtx, uuid: string, seq: number): string | undefined => ctx.nameOf(uuid, seq);

/**
 * A token's display name, routed through a noun-phrase when null (hardening §2.2:
 * 10 of 12 token classes allow `name: string | null` → never `''` / `"null"`).
 * DRAFT — V review.
 */
function namedOr(ctx: LensCtx, t: string, uuid: string, seq: number): string {
  const n = name(ctx, uuid, seq);
  return n != null && n !== "" ? `"${n}"` : `an unnamed ${tokenNoun(t)}`;
}

/**
 * Best-effort human label for a combo `change.key` (the `Set<VariantString>` map key
 * serialized `Set\n<line>…`). Empty / `"Set"` → base. Each member line is a JSON tuple
 * `["media",feature,value]` or `["pseudo",name]` (token-variance.ts serde). We render
 * the discrete value / pseudo name; unparseable → "a variant". Cross-doc the lens has no
 * resolver, so this stays best-effort + DRAFT — V review (wording + the dark-mode phrasing
 * the design's `comboLabel` mandates lives in the host resolver, not here).
 */
function comboKeyLabel(key: string | undefined): string | null {
  if (key === undefined) return null;
  const [prefix, ...lines] = key.split("\n");
  if (prefix !== "Set") return null; // not a combo key shape
  if (lines.length === 0) return null; // empty set = base value
  const parts: string[] = [];
  for (const line of lines) {
    try {
      const tuple = JSON.parse(line) as string[];
      if (tuple[0] === "media") parts.push(tuple[2] ?? "a media state"); // e.g. "dark" — DRAFT
      else if (tuple[0] === "pseudo") parts.push(`:${tuple[1]}`); // e.g. ":hover" — DRAFT
      else parts.push("a variant");
    } catch {
      parts.push("a variant");
    }
  }
  return parts.join(" + ");
}

/**
 * Is a `values`-entry value an ALIAS (a structural `CustomCode` pointer in `after`, or a
 * legacy `var(--token-<uuid>)` CSS string) rather than a literal? (StyleToken.ts:60-62
 * documents both forms; the structural CustomCode arrives as a non-string object —
 * unlabeled, hardening §2.2.) We can tell alias-vs-literal; the target token name needs a
 * deref pass we lack → phrase generically.
 */
function looksLikeAlias(v: unknown): boolean {
  if (typeof v === "string") return /var\(\s*--(?:token|here)-/.test(v);
  // A structural CustomCode pointer serializes as a non-string ref object/array.
  return typeof v === "object" && v !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent-kind TYPES (design §1 "Tokens & Theme" block; split per hardening §2.3)
// ─────────────────────────────────────────────────────────────────────────────

/** A token (any kind) was created. `tokenNoun` is the per-class noun; `detail` adds kind/base. */
export interface TokenCreated extends IntentEventBase {
  kind: "TokenCreated";
  /** the `@syncing` entity type (StyleToken/ColorToken/…); humanizes via `tokenNoun`. */
  tokenType: string;
  /** display name, or null → noun-phrase ("an unnamed shadow token"). */
  name: string | null;
  /** optional creation detail: a StyleToken value-kind, or a gradient type. */
  detail?: string;
}

/** A token was renamed (`name` set with `before` present, or null→name "named"). */
export interface TokenRenamed extends IntentEventBase {
  kind: "TokenRenamed";
  tokenType: string;
  /** null when the token had no prior name (a first naming). */
  from: string | null;
  to: string;
}

/** A token was deleted (detached from Site). Name resolved point-in-time. */
export interface TokenDeleted extends IntentEventBase {
  kind: "TokenDeleted";
  tokenType: string;
  name: string | null;
}

/**
 * A token's base/value changed (Color/Style/Box/Typeface `values` entry edit, or a
 * gradient geometry scalar). `combo` is the variant-combo label (null = base / scalar).
 * `becameAlias` distinguishes an alias-rewire from a literal change (target name DRAFT).
 */
export interface TokenValueChanged extends IntentEventBase {
  kind: "TokenValueChanged";
  tokenType: string;
  name: string | null;
  /** the per-combo label (e.g. "dark", ":hover") or null for the base / a scalar geometry. */
  combo: string | null;
  /** for a record-value composite (Box/Typeface): the CSS prop the entry keys. */
  prop?: string;
  /** the new value, pre-stringified (a literal CSS value or a felt geometry); omitted for alias. */
  to?: string;
  /** the prior value, when paired (enables a felt delta downstream). */
  from?: string;
  /** true when the new value is a token alias (a CustomCode pointer / var(--…) ref). */
  becameAlias?: boolean;
}

/** A token's per-combo override was CLEARED (falls back to base). */
export interface TokenValueCleared extends IntentEventBase {
  kind: "TokenValueCleared";
  tokenType: string;
  name: string | null;
  /** the cleared combo's label, or the CSS prop for a record-value composite. */
  at: string | null;
}

/** A token's `exportTier` (publish stability) changed. */
export interface TokenExportTierChanged extends IntentEventBase {
  kind: "TokenExportTierChanged";
  tokenType: string;
  name: string | null;
  /** "stable" | "beta" | null (unpublished). */
  tier: "stable" | "beta" | null;
}

/** A StyleToken's classification changed (valueKind / cluster / tags). */
export interface TokenClassificationChanged extends IntentEventBase {
  kind: "TokenClassificationChanged";
  name: string | null;
  /** which facet moved. */
  facet: "valueKind" | "cluster" | "tags";
  /** the new value, pre-phrased (a value-kind, a cluster name, or a tag op). */
  to: string;
}

/** A composite token's same-kind composition (`extends` list) changed. */
export interface TokenCompositionChanged extends IntentEventBase {
  kind: "TokenCompositionChanged";
  tokenType: string;
  name: string | null;
  op: "extended" | "unextended" | "reordered";
}

/** A color palette (application: function × base) changed. */
export interface PaletteApplicationChanged extends IntentEventBase {
  kind: "PaletteApplicationChanged";
  /** created — a new ColorPalette; baseChanged — reseeded; functionChanged — recipe swap;
   *  descriptionEdited — the prose. */
  op: "created" | "baseChanged" | "functionChanged" | "descriptionEdited";
  name: string;
}

/** A palette RECIPE (PaletteFunction / PaletteFunctionStep — shared, fans out) changed. */
export interface PaletteRecipeChanged extends IntentEventBase {
  kind: "PaletteRecipeChanged";
  /** created — new recipe; stepAdded/stepRemoved/stepRenamed — a step; derivationEdited — a
   *  step's color expression; descriptionEdited — the recipe prose. */
  op: "created" | "stepAdded" | "stepRemoved" | "stepRenamed" | "derivationEdited" | "descriptionEdited";
  /** the recipe's name (or the step name where relevant). */
  name: string;
}

/** A custom font changed (uploaded, faces edited, or feature/axis labels relabelled). */
export interface FontChanged extends IntentEventBase {
  kind: "FontChanged";
  /** uploaded — a new CustomFont; faceChanged — a StaticFontFile/VariableFontFile add/remove;
   *  labelsEdited — featureLabels/axisLabels (scalar-JSON, per-tag unrecoverable, hardening §2.2);
   *  renamed — the family name. */
  op: "uploaded" | "faceChanged" | "labelsEdited" | "renamed";
  name: string;
  /** for labelsEdited: which scalar-JSON channel; for renamed: the new name. */
  detail?: string;
}

/** A web-font family was added/removed via `Site.userManagedFonts` (the value IS the label). */
export interface WebFontChanged extends IntentEventBase {
  kind: "WebFontChanged";
  op: "added" | "removed";
  /** the font family (the @syncing.set element value — no key-loss, no deref). */
  family: string;
}

/** An image asset changed (added, renamed, reclassified, or keyworded). */
export interface AssetChanged extends IntentEventBase {
  kind: "AssetChanged";
  op: "added" | "renamed" | "reclassified" | "keyworded";
  name: string;
  /** for renamed: the new name; reclassified: the type; keyworded: the keyword. */
  detail?: string;
}

/** The by-tag theme floor changed (an ElementDefault channel set/cleared). */
export interface ThemeElementDefaultChanged extends IntentEventBase {
  kind: "ThemeElementDefaultChanged";
  /** the channel the binding moved (v0: "textStyle"; "surface"/"box" join later). */
  channel: string;
  /** set | cleared — whether a pack was bound or removed. */
  op: "set" | "cleared";
}

/** Every intent kind the Tokens & Theme area owns. */
export type TokensIntent =
  | TokenCreated
  | TokenRenamed
  | TokenDeleted
  | TokenValueChanged
  | TokenValueCleared
  | TokenExportTierChanged
  | TokenClassificationChanged
  | TokenCompositionChanged
  | PaletteApplicationChanged
  | PaletteRecipeChanged
  | FontChanged
  | WebFontChanged
  | AssetChanged
  | ThemeElementDefaultChanged;

// ─────────────────────────────────────────────────────────────────────────────
// The area module
// ─────────────────────────────────────────────────────────────────────────────

export const tokensArea: AreaModule = {
  name: "Tokens/Theme",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): TokensIntent | null {
    const t = root.entity.type;
    const u = root.entity.uuid;
    const nm = name(ctx, u, meta.seq) ?? null;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

    // ── Any token-kind birth → TokenCreated (per-class noun). The token's own
    //    fresh children — GradientStop, ShadowLayer, BackgroundLayer, TextStyleCell,
    //    StaticFontFile, … — were already MERGED by the pipeline (fresh descendant of
    //    a fresh root), and the birth value-sets (`values` entries, geometry scalars)
    //    ride as ∅→X on the FRESH entity → also absorbed. So we only stamp the anchor.
    if (isTokenType(t)) {
      const detail = t === "GradientToken" ? gradientTypeAtBirth(root) : undefined;
      return { kind: "TokenCreated", tokenType: t, name: nm, ...(detail ? { detail } : {}), ...base };
    }

    // ── Palette application (ColorPalette) ──────────────────────────────────
    if (t === "ColorPalette") {
      return { kind: "PaletteApplicationChanged", op: "created", name: nm ?? "?", ...base };
    }

    // ── Palette recipe (PaletteFunction). Its PaletteFunctionStep children MERGE. ─
    if (t === "PaletteFunction") {
      return { kind: "PaletteRecipeChanged", op: "created", name: nm ?? "?", ...base };
    }
    // A fresh PaletteFunctionStep under a NON-fresh PaletteFunction = a step added to an
    // existing recipe (fresh child of non-fresh parent — hardening §1.7). (Under a fresh
    // function it's birth payload → already merged.)
    if (t === "PaletteFunctionStep") {
      return { kind: "PaletteRecipeChanged", op: "stepAdded", name: nm ?? "?", ...base };
    }

    // ── Fonts & assets ──────────────────────────────────────────────────────
    if (t === "CustomFont") {
      return { kind: "FontChanged", op: "uploaded", name: nm ?? "?", ...base };
    }
    // A fresh StaticFontFile/VariableFontFile under a NON-fresh CustomFont = a face added.
    if (t === "StaticFontFile" || t === "VariableFontFile") {
      return { kind: "FontChanged", op: "faceChanged", name: ownerName(ctx, u, meta.seq), ...base };
    }
    if (t === "ImageAsset") {
      return { kind: "AssetChanged", op: "added", name: nm ?? "?", ...base };
    }

    // ── Theme floor (ElementDefault under Site.elementDefaults) ───────────────
    // A fresh ElementDefault = a tag's ambient default just got a binding. The tag is the
    // record KEY (lost as an entity-own field here) → channel is generic at birth (the
    // channel `textStyle` ref rides as a child set we don't separate). DRAFT.
    if (t === "ElementDefault") {
      return { kind: "ThemeElementDefaultChanged", channel: "textStyle", op: "set", ...base };
    }

    // PaletteToken (derived/virtual genesis) is NOT ours — defer (→ pipeline drop / RawEdit).
    return null;
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): TokensIntent | null {
    const t = c.entity.type;
    const u = c.entity.uuid;
    const nm = name(ctx, u, meta.seq) ?? null;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

    // ── Token detach (any kind) → deleted ─────────────────────────────────────
    if (c.verb === "detach" && isTokenType(t)) {
      return { kind: "TokenDeleted", tokenType: t, name: nm, ...base };
    }

    // ── Shared scalar edits on any token kind ──────────────────────────────────
    if (isTokenType(t)) {
      // name rename (before present), or first-naming (null → name).
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "TokenRenamed", tokenType: t, from: c.before == null ? null : str(c.before), to: str(c.after), ...base };
      }
      // exportTier publish-tier change.
      if (c.verb === "set" && c.field === "exportTier" && c.before !== undefined) {
        const tier = c.after === "stable" || c.after === "beta" ? c.after : null;
        return { kind: "TokenExportTierChanged", tokenType: t, name: nm, tier, ...base };
      }
      // `extends` (composite same-kind composition) — a @syncing.list of foreign refs.
      if (c.field === "extends") {
        if (c.verb === "reorder") return { kind: "TokenCompositionChanged", tokenType: t, name: nm, op: "reordered", ...base };
        if (c.verb === "insert") return { kind: "TokenCompositionChanged", tokenType: t, name: nm, op: "extended", ...base };
        if (c.verb === "remove") return { kind: "TokenCompositionChanged", tokenType: t, name: nm, op: "unextended", ...base };
      }
    }

    // ── StyleToken classification facets (valueKind / cluster / tags) ──────────
    if (t === "StyleToken") {
      if (c.verb === "set" && c.field === "valueKind" && c.before !== undefined) {
        return { kind: "TokenClassificationChanged", name: nm, facet: "valueKind", to: str(c.after), ...base };
      }
      if (c.verb === "set" && c.field === "cluster" && c.before !== undefined) {
        return { kind: "TokenClassificationChanged", name: nm, facet: "cluster", to: str(c.after), ...base };
      }
      // tags is a @syncing.set<string> — insert/remove (value IS the tag).
      if (c.field === "tags" && (c.verb === "insert" || c.verb === "remove")) {
        const tag = str(c.verb === "insert" ? c.after : c.before);
        return { kind: "TokenClassificationChanged", name: nm, facet: "tags", to: `${c.verb === "insert" ? "+" : "−"}${tag}`, ...base };
      }
    }

    // ── Combo-keyed value edits (StyleToken / ColorToken `values` @syncing.map) ──
    // Paired+keyed in the lift: `set field:"values" key:<Set-combo> before after`.
    // base combo = empty Set ("Set" / "") → combo:null.
    if (COMBO_VALUE_TOKENS.has(t) && c.field === "values") {
      if (c.verb === "set") {
        return {
          kind: "TokenValueChanged",
          tokenType: t,
          name: nm,
          combo: comboKeyLabel(c.key),
          ...(looksLikeAlias(c.after) ? { becameAlias: true } : { to: str(c.after) }),
          ...(c.before !== undefined && !looksLikeAlias(c.before) ? { from: str(c.before) } : {}),
          ...base,
        };
      }
      if (c.verb === "clear") {
        return { kind: "TokenValueCleared", tokenType: t, name: nm, at: comboKeyLabel(c.key), ...base };
      }
    }

    // ── Record-value composites (Box/Typeface `values` @syncing.child.record) ───
    // Also Y.Map → keyed+paired; `key` = the CSS prop. (TextStyleToken.values is a
    // child.map of TextStyleCell ENTITIES → its edits are cell-entity edits / births
    // handled via the merge + the cell's own fields; the per-prop value lives on the
    // cell, attributed to the TextStyleToken via the owner walk — left to RawEdit
    // until a cell→token owner-walk lands, see notes.)
    if (RECORD_VALUE_TOKENS.has(t) && c.field === "values") {
      if (c.verb === "set") {
        return {
          kind: "TokenValueChanged",
          tokenType: t,
          name: nm,
          combo: null,
          prop: c.key,
          ...(looksLikeAlias(c.after) ? { becameAlias: true } : { to: str(c.after) }),
          ...(c.before !== undefined && !looksLikeAlias(c.before) ? { from: str(c.before) } : {}),
          ...base,
        };
      }
      if (c.verb === "clear") {
        return { kind: "TokenValueCleared", tokenType: t, name: nm, at: c.key ?? null, ...base };
      }
    }

    // ── GradientToken geometry scalars (felt deltas — attribute-backed, paired) ──
    if (t === "GradientToken" && c.verb === "set" && c.before !== undefined) {
      if (c.field === "angle") return { kind: "TokenValueChanged", tokenType: t, name: nm, combo: null, to: `${str(c.after)}°`, from: `${str(c.before)}°`, ...base };
      if (c.field === "gradientType") return { kind: "TokenValueChanged", tokenType: t, name: nm, combo: null, to: str(c.after), ...base };
      if (c.field === "repeating") return { kind: "TokenValueChanged", tokenType: t, name: nm, combo: null, to: c.after === true ? "repeating" : "non-repeating", ...base };
      // cx/cy/rx/ry radial/conic geometry — felt position values.
      if (c.field === "cx" || c.field === "cy" || c.field === "rx" || c.field === "ry") {
        return { kind: "TokenValueChanged", tokenType: t, name: nm, combo: null, to: `${c.field} ${str(c.after)}`, from: `${c.field} ${str(c.before)}`, ...base };
      }
    }

    // ── EffectsToken scalar opacity / mix-blend-mode (own fields, not a layer) ──
    if (t === "EffectsToken" && c.verb === "set" && c.before !== undefined && (c.field === "opacity" || c.field === "mixBlendMode")) {
      return { kind: "TokenValueChanged", tokenType: t, name: nm, combo: null, to: `${c.field} ${str(c.after)}`, from: `${c.field} ${str(c.before)}`, ...base };
    }

    // ── Palette application edits (ColorPalette base/function/description) ──────
    if (t === "ColorPalette") {
      if (c.verb === "detach") return { kind: "PaletteApplicationChanged", op: "created", name: nm ?? "?", ...base }; // NOTE: see notes — no PaletteDeleted kind yet
      if (c.verb === "set" && c.field === "base" && c.before !== undefined) {
        return { kind: "PaletteApplicationChanged", op: "baseChanged", name: nm ?? "?", ...base };
      }
      if (c.verb === "set" && c.field === "function" && c.before !== undefined) {
        return { kind: "PaletteApplicationChanged", op: "functionChanged", name: nm ?? "?", ...base };
      }
      // description: string = "" → a non-fresh edit with before present is a real edit.
      if (c.verb === "set" && c.field === "description" && c.before !== undefined) {
        return { kind: "PaletteApplicationChanged", op: "descriptionEdited", name: nm ?? "?", ...base };
      }
    }

    // ── Palette recipe edits (PaletteFunction / PaletteFunctionStep) ───────────
    if (t === "PaletteFunction") {
      if (c.verb === "set" && c.field === "description" && c.before !== undefined) {
        return { kind: "PaletteRecipeChanged", op: "descriptionEdited", name: nm ?? "?", ...base };
      }
      // steps reorder/remove (reorder/remove on @syncing.child.list); step ADD is the
      // PaletteFunctionStep birth (recognizeBirth). A step removal is the step's detach
      // (caught below by entity type), so steps-list remove here is the mirror → skip to
      // avoid double-count; only surface a reorder.
      if (c.field === "steps" && c.verb === "reorder") {
        return { kind: "PaletteRecipeChanged", op: "derivationEdited", name: nm ?? "?", ...base }; // DRAFT — reorder→reworked-order
      }
    }
    if (t === "PaletteFunctionStep") {
      if (c.verb === "detach") return { kind: "PaletteRecipeChanged", op: "stepRemoved", name: nm ?? "?", ...base };
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "PaletteRecipeChanged", op: "stepRenamed", name: str(c.after), ...base };
      }
      // derivations is a @syncing.child.map of CustomCode ENTITIES keyed by combo — a
      // derivation EDIT is a CustomCode child set/birth; surface as derivationEdited.
      if (c.field === "derivations") {
        return { kind: "PaletteRecipeChanged", op: "derivationEdited", name: nm ?? "?", ...base };
      }
    }

    // ── Custom font edits (faces detach, labels, rename) ──────────────────────
    if (t === "CustomFont") {
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "FontChanged", op: "renamed", name: str(c.before), detail: str(c.after), ...base };
      }
      // featureLabels / axisLabels — SCALAR JSON-string attrs (hardening §2.2 second
      // key-loss class): a per-tag delta is unrecoverable from one whole-blob set, so we
      // phrase the channel only.
      if (c.verb === "set" && (c.field === "featureLabels" || c.field === "axisLabels")) {
        return { kind: "FontChanged", op: "labelsEdited", name: nm ?? "?", detail: c.field === "featureLabels" ? "feature" : "axis", ...base };
      }
      if (c.field === "originalFilename" && (c.verb === "set" || c.verb === "clear")) {
        return { kind: "FontChanged", op: "renamed", name: nm ?? "?", detail: str(c.after), ...base }; // DRAFT — original-filename is metadata; weak EMIT
      }
    }
    // A face (StaticFontFile/VariableFontFile) detached from a non-fresh font.
    if ((t === "StaticFontFile" || t === "VariableFontFile") && c.verb === "detach") {
      return { kind: "FontChanged", op: "faceChanged", name: ownerName(ctx, u, meta.seq), ...base };
    }

    // ── Image asset edits ─────────────────────────────────────────────────────
    if (t === "ImageAsset") {
      if (c.verb === "detach") return { kind: "AssetChanged", op: "reclassified", name: nm ?? "?", detail: "removed", ...base }; // NOTE: no AssetRemoved kind — see notes
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "AssetChanged", op: "renamed", name: str(c.before), detail: str(c.after), ...base };
      }
      if (c.verb === "set" && c.field === "type" && c.before !== undefined) {
        return { kind: "AssetChanged", op: "reclassified", name: nm ?? "?", detail: str(c.after), ...base };
      }
      // keywords is a @syncing.list<string> — insert/remove (value IS the keyword).
      if (c.field === "keywords" && (c.verb === "insert" || c.verb === "remove")) {
        return { kind: "AssetChanged", op: "keyworded", name: nm ?? "?", detail: `${c.verb === "insert" ? "+" : "−"}${str(c.verb === "insert" ? c.after : c.before)}`, ...base };
      }
      // origin set (provenance URN) — weak EMIT, low salience.
      if (c.verb === "set" && c.field === "origin" && c.before !== undefined) {
        return { kind: "AssetChanged", op: "reclassified", name: nm ?? "?", detail: "re-sourced", ...base }; // DRAFT — V review
      }
      // width / height / aspectRatio / dataUri are machine-derived (hardening §3.2:
      // "DROP machine-derived") → DEFER to RawEdit (consciously not an intent).
    }

    // ── Web fonts (Site.userManagedFonts @syncing.set<string>) ────────────────
    // The element value IS the family label — no key-loss, no deref (hardening §3.2:
    // the baseline's "DROP" silently erased a first-class gesture).
    if (t === "Site" && c.field === "userManagedFonts" && (c.verb === "insert" || c.verb === "remove")) {
      return { kind: "WebFontChanged", op: c.verb === "insert" ? "added" : "removed", family: str(c.verb === "insert" ? c.after : c.before), ...base };
    }

    // ── Theme floor edits (ElementDefault channel set/cleared) ────────────────
    if (t === "ElementDefault" && (c.field === "textStyle" || c.field === "surface" || c.field === "box")) {
      if (c.verb === "set") return { kind: "ThemeElementDefaultChanged", channel: c.field, op: "set", ...base };
      if (c.verb === "clear") return { kind: "ThemeElementDefaultChanged", channel: c.field, op: "cleared", ...base };
    }

    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "TokenCreated": {
        const noun = e.tokenType === "StyleToken" && e.detail ? `${STYLE_TOKEN_KIND[e.detail] ?? e.detail} token` : tokenNoun(e.tokenType);
        const named = e.name ? `"${e.name}"` : `an unnamed ${noun}`;
        const extra = e.tokenType === "GradientToken" && e.detail ? ` (${e.detail})` : "";
        return e.name ? `Added ${noun} ${named}${extra}` : `Added ${named}${extra}`; // DRAFT — V review
      }
      case "TokenRenamed":
        return e.from == null ? `Named a ${tokenNoun(e.tokenType)} "${e.to}"` : `Renamed ${tokenNoun(e.tokenType)} "${e.from}" → "${e.to}"`; // DRAFT — V review
      case "TokenDeleted":
        return e.name ? `Deleted ${tokenNoun(e.tokenType)} "${e.name}"` : `Deleted an unnamed ${tokenNoun(e.tokenType)}`; // DRAFT — V review
      case "TokenValueChanged": {
        const subj = e.name ? `"${e.name}"` : `an unnamed ${tokenNoun(e.tokenType)}`;
        const where = e.combo ? ` (${e.combo})` : e.prop ? ` ${e.prop}` : "";
        if (e.becameAlias) return `${subj}${where} now points at another token`; // DRAFT — target name needs deref pass
        if (e.from !== undefined && e.to !== undefined && e.from !== e.to) return `${subj}${where}: ${e.from} → ${e.to}`; // DRAFT — felt delta downstream
        return `${subj}${where}: → ${e.to ?? "(changed)"}`; // DRAFT — V review
      }
      case "TokenValueCleared": {
        const subj = e.name ? `"${e.name}"` : `an unnamed ${tokenNoun(e.tokenType)}`;
        return e.at ? `${subj}: removed the ${e.at} override (falls back to base)` : `${subj}: removed an override`; // DRAFT — V review
      }
      case "TokenExportTierChanged": {
        const subj = e.name ? `"${e.name}"` : `an unnamed ${tokenNoun(e.tokenType)}`;
        if (e.tier === null) return `Unpublished ${subj}`; // DRAFT — V review
        return `Marked ${subj} ${e.tier} for publishing`; // DRAFT — V review
      }
      case "TokenClassificationChanged": {
        const subj = e.name ? `Token "${e.name}"` : "A token";
        if (e.facet === "tags") return `${subj}: ${e.to.startsWith("+") ? "tagged" : "untagged"} "${e.to.slice(1)}"`; // DRAFT
        if (e.facet === "cluster") return `${subj}: moved to the "${e.to}" cluster`; // DRAFT — V review
        return `${subj}: classified as ${e.to}`; // DRAFT — V review
      }
      case "TokenCompositionChanged": {
        const subj = e.name ? `"${e.name}"` : `an unnamed ${tokenNoun(e.tokenType)}`;
        if (e.op === "reordered") return `Reordered the bases of ${subj}`; // DRAFT — V review
        return e.op === "extended" ? `${subj} now extends another ${tokenNoun(e.tokenType)}` : `${subj} no longer extends one of its bases`; // DRAFT
      }
      case "PaletteApplicationChanged":
        switch (e.op) {
          case "created":
            return `Added color palette "${e.name}"`; // DRAFT — V review
          case "baseChanged":
            return `Palette "${e.name}": reseeded its base color`; // DRAFT — V review
          case "functionChanged":
            return `Palette "${e.name}": switched recipe`; // DRAFT — V review
          case "descriptionEdited":
            return `Palette "${e.name}": edited the description`; // DRAFT — V review
        }
        return null;
      case "PaletteRecipeChanged":
        switch (e.op) {
          case "created":
            return `Added palette recipe "${e.name}"`; // DRAFT — V review
          case "stepAdded":
            return `Recipe: added step "${e.name}"`; // DRAFT — V review
          case "stepRemoved":
            return `Recipe: removed step "${e.name}"`; // DRAFT — V review
          case "stepRenamed":
            return `Recipe: renamed a step → "${e.name}"`; // DRAFT — V review
          case "derivationEdited":
            return `Recipe "${e.name}": reworked a color step`; // DRAFT — V review (fans out to every palette)
          case "descriptionEdited":
            return `Recipe "${e.name}": edited the description`; // DRAFT — V review
        }
        return null;
      case "FontChanged":
        switch (e.op) {
          case "uploaded":
            return `Uploaded font "${e.name}"`; // DRAFT — V review (faceSummary deferred)
          case "faceChanged":
            return `Font "${e.name}": changed a face`; // DRAFT — V review
          case "labelsEdited":
            return `Font "${e.name}": relabeled a ${e.detail ?? "feature"}`; // DRAFT — per-tag unrecoverable
          case "renamed":
            return `Renamed font → "${e.detail ?? e.name}"`; // DRAFT — V review
        }
        return null;
      case "WebFontChanged":
        return e.op === "added" ? `Added web font "${e.family}"` : `Removed web font "${e.family}"`; // DRAFT — V review
      case "AssetChanged":
        switch (e.op) {
          case "added":
            return `Added asset "${e.name}"`; // DRAFT — V review (icon/image distinction deferred)
          case "renamed":
            return `Renamed asset "${e.name}" → "${e.detail ?? "?"}"`; // DRAFT — V review
          case "reclassified":
            return e.detail === "removed" ? `Removed asset "${e.name}"` : `Asset "${e.name}": ${e.detail ?? "reclassified"}`; // DRAFT
          case "keyworded":
            return `Asset "${e.name}": ${e.detail?.startsWith("+") ? "added" : "removed"} keyword "${e.detail?.slice(1) ?? ""}"`; // DRAFT
        }
        return null;
      case "ThemeElementDefaultChanged":
        return e.op === "set" ? `Set the default ${e.channel} for an element type` : `Cleared the default ${e.channel} for an element type`; // DRAFT — tag is the lost record key
      default:
        return null;
    }
  },
};

/** A gradient's `gradientType` at birth — rides as a `set ∅→X` on the FRESH token (absorbed),
 *  so we read it directly off the materialize cut is not possible here; left for the merged-set
 *  to be passed (deferred, like params-states-types StateAdded.friendlyType). Returns undefined.
 *  DRAFT — to fill, the pipeline would surface the merged birth-payload sets. */
function gradientTypeAtBirth(_root: PlexusChange): string | undefined {
  return undefined;
}

/** Owner (parent) display name via the owner walk, or "?" when unresolved. */
function ownerName(ctx: LensCtx, uuid: string, seq: number): string {
  const o = ctx.ownerOf?.(uuid, seq);
  return (o ? ctx.nameOf(o, seq) : undefined) ?? "?";
}
