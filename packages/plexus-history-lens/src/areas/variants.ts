import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Variants & Environments  (design §1 "Variants & Environments", §3 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * A here.build component (or the Site, for global axes) has VARIANCE AXES — a
 * `VariantGroup` observes a SUBJECT (a State / Environment / CustomCode) and holds
 * the named `Variant` options, each a condition `(operator, right)` tested against
 * the subject. The render tree activates a combination of variants per node; a
 * `VariantsCombination` is a DNF expr-constant naming a set of variants (used in
 * `$show` predicates). This area owns the axis + variant lifecycle (add / remove /
 * rename / retarget / promote) and the per-variant condition edit.
 *
 * ── Entity types this area OWNS (the `@syncing("…")` nodeName the lift stamps into
 *    `entity.type`; verified against the model source this pass — Variant.ts /
 *    VariantGroup.ts / render/VariantCombination.ts) ──
 *   - "VariantGroup"   — a variance axis. Fields: `name`, `subject` (a REF, attr →
 *                        a uuid in after, NOT decorate-labeled — hardening §4.3#4),
 *                        `variants` (@syncing.child.list of Variant), `standalone`
 *                        (the single on/off-toggle flag, `= false`).
 *   - "Variant"        — one option in a group. Fields: `name`, `description`
 *                        (`string | null`, no initializer → birth `∅→null`),
 *                        `operator` (`VariantOperator | null = null`), `right`
 *                        (@syncing.child: CustomCode | UnionValue | PageComponent | null).
 *   - "VariantsCombination" — a DNF set-of-variant-refs expr (`variants: VariantCombo`,
 *                        @syncing.list). Parent is an `ArgsSet` (a render-tree node
 *                        activation), NOT a variance entity → CONSCIOUSLY DROPPED here
 *                        (cross-area double-emission, see boundary note + integrate flag).
 *
 * ── How the CENTRAL pipeline frames births (consolidate.ts) ──────────────────
 * A `materialized` whose parent (recovered from its same-cut `reparent.to`) is ALSO
 * fresh is a fresh DESCENDANT → absorbed. So:
 *   - the `variants` of a brand-new VariantGroup are fresh descendants of the fresh
 *     group → absorbed centrally (a new axis = ONE VariantAxisChanged, not axis + N
 *     VariantChanged). `right` likewise (a fresh child of the fresh Variant).
 *   - a `Variant` materialized under a NON-fresh VariantGroup is a BIRTH ROOT → our
 *     VariantChanged:added (hardening §1.7 "fresh child of a non-fresh parent").
 *
 * ── ★ REGISTRY-ORDERING NOTE (flag for integrate) ────────────────────────────
 * Hardening §1.8: "add a variant axis" fires TWO co-fresh PEER births in one cut —
 * a fresh `State` (pushed to `component.states`) AND a fresh `VariantGroup` whose
 * `subject` REF points at that State. They are PEERS (the State is parented to
 * `component.states`, NOT to the group), so the pipeline's fresh-DESCENDANT merge
 * does NOT fold them, and BOTH reach `recognizeBirth` as roots. The group copies
 * `subject.name`, so the names are identical → guaranteed double-emission
 * ("Added variable 'size'" + "Added variance axis 'size'").
 *
 * The resolution per hardening §1.8 is: **Variants must run BEFORE Params/States/Types
 * in the registry, and FOLD its co-fresh variant-subject State** so the Params area
 * never emits a StateAdded for it.
 *
 * BUT the current `AreaModule.recognizeBirth(root, ctx, meta, fresh)` contract CANNOT
 * express that fold: offered the VariantGroup root, the subject value lives in a
 * SEPARATE `set {field:"subject"}` change we are not handed; offered the State root,
 * we cannot see whether a co-fresh VariantGroup points back at it (`fresh` is a bare
 * uuid-set; `ctx` has only `nameOf`/`ownerOf`). So the fold needs ONE of (integration
 * decides):
 *   (a) `recognizeBirth` also receives the full cut `PlexusChange[]` (so we can find
 *       the co-fresh VariantGroup whose `subject` set-after === the State root), OR
 *   (b) a `ctx` helper — `ctx.subjectOf?(vgUuid, seq)` (group→subject uuid) AND/OR
 *       `ctx.isVariantSubject?(stateUuid, seq)` (reverse) resolved from the model.
 * With (a) or (b), this module's `recognizeBirth` folds the State and the Params area
 * defers by construction. UNTIL then, registering Variants first is NECESSARY but NOT
 * SUFFICIENT — the State still double-emits. We emit the axis correctly; the State
 * de-dup is the integration's open edge. (Type-bearing State.subject naming reads via
 * `nameOf(vgUuid)` regardless — VariantGroup.name IS subject-derived, so the axis line
 * is correct with neither (a) nor (b).)
 *
 * ── Boundary calls (where the cut crosses into a neighbouring area) ──────────
 *   - `VariantsCombination` — parent is `ArgsSet` (node activation), a render-tree /
 *     node-activation concern (design §4 open #3 + hardening §4 cross-area table:
 *     "DROP it in the Variants area, mirroring Site.components owned by Component").
 *     CONSCIOUSLY DROPPED (returns null → central salience-drop / RawEdit). When a
 *     node-activation area lands it owns the combination; flagged for integrate.
 *   - The SUBJECT entities themselves — `State` (Params area), `MediaEnvironment` /
 *     `ElementEnvironment` / `RouterEnvironment` (platform-declared; genesis-seeded
 *     envs are DROPPED by the central genesis filter). We touch the subject only as
 *     the axis's `subject` REF (the "driven by / now reacts to" fact), never its body.
 *   - `Variant.right` is a CustomCode | UnionValue | PageComponent (@syncing.child).
 *     Its CustomCode body is the Behavior/Expression area; we surface only that the
 *     condition changed. The ref value (UnionValue/PageComponent) in a `set` after is
 *     NOT decorate-labeled (hardening §4.3#4) → condition reads coarse (below).
 *   - `pseudoVariantGroups` (a `@syncing.child.record` on Component, keyed by pseudo
 *     name `hover`/`focus`/…) is the `:hover`-styling gesture. A VariantGroup born
 *     under it is `PseudoStateStylingChanged`, NOT a generic axis add. The pseudo NAME
 *     is the record-ENTRY key, which the lift drops (reparent carries only `tuple[1]` =
 *     the field `pseudoVariantGroups`, not the entry key) → phrased without the pseudo
 *     name (hardening marks this ⚠key (pseudo name)).
 */

// ── Entity-type / field sets (verified @syncing nodeNames + child-list keys) ──
const isVariantGroup = (t: string): boolean => t === "VariantGroup";
const isVariant = (t: string): boolean => t === "Variant";

// The child-record field a pseudo-styling VariantGroup sits in (`Component.pseudoVariantGroups`,
// verified ComponentBase.ts). The lift carries this as `field` = the `\0` tuple[1] on
// reparent/detach, so DETACH-time placement (pseudo vs ordinary axis) is discriminable.
// (Site axis lists `mediaVariantGroups`/`stateVariantGroups` aren't needed as a set: the
// `global` flag derives from "no owning Component" via the owner walk — see recognizeBirth.)
const PSEUDO_FIELD = "pseudoVariantGroups";

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
const name = (ctx: LensCtx, uuid: string, seq: number): string => ctx.nameOf(uuid, seq) ?? "?";
const owner = (ctx: LensCtx, uuid: string, seq: number): string =>
  (ctx.ownerOf ? (ctx.nameOf(ctx.ownerOf(uuid, seq) ?? "", seq) ?? "?") : "?");

// VariantOperator (verified variant-operator.ts) → human phrase. `null` ≡ `===`
// (the model's documented default). DRAFT — V review (wording).
const OPERATOR_PHRASE: Record<string, string> = {
  "===": "is",
  "!==": "is not",
  "<": "is under",
  "<=": "is at most",
  ">=": "is at least",
  ">": "is over",
};
const operatorPhrase = (op: unknown): string =>
  op == null ? "is" : (OPERATOR_PHRASE[String(op)] ?? String(op)); // DRAFT — V review

// ─────────────────────────────────────────────────────────────────────────────
// Intent-kind TYPES (design §1 "Variants & Environments" block)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A variance AXIS (`VariantGroup`) was added / removed / renamed / retargeted / promoted.
 * One kind with a `subKind` enum — the design's "one variant per intent FAMILY" rule
 * (the family is "the axis changed"; §1.1). `axis` is the group name (subject-derived;
 * resolved via `nameOf` — VariantGroup.name copies subject.name, so this is correct
 * without dereferencing the subject ref).
 */
export interface VariantAxisChanged extends IntentEventBase {
  kind: "VariantAxisChanged";
  subKind: "added" | "removed" | "renamed" | "toggleMode" | "subjectRebound" | "promoted";
  /** the axis (group) name; for `renamed` this is the NEW name (`to`). */
  axis: string;
  /** present on `renamed` — the prior name. */
  from?: string;
  /** present on `added` — true when the axis is a site-wide (global) axis. */
  global?: boolean;
  /** present on `toggleMode` — true ⇒ now a single on/off toggle (`standalone`). */
  standalone?: boolean;
}

/**
 * A single `Variant` (an option within an axis) was added / removed / renamed, had its
 * CONDITION edited, or got a description. One kind, `subKind` family ("the variant
 * changed"). `group` is the owning axis name (resolved via the owner walk).
 */
export interface VariantChanged extends IntentEventBase {
  kind: "VariantChanged";
  subKind: "added" | "removed" | "renamed" | "condition" | "description";
  /** the variant's display name; for `renamed` the NEW name (`to`). */
  variant: string;
  /** the owning axis (VariantGroup) name (via the owner walk; "?" if unresolved). */
  group: string;
  /** present on `renamed` — the prior name. */
  from?: string;
  /** present on `condition` — the operator phrase ("is at least", "is", …). */
  operatorPhrase?: string;
}

/**
 * A UA-pseudo styling axis (`:hover` / `:focus` / …) was enabled / removed — a
 * VariantGroup born under / detached from `Component.pseudoVariantGroups`. The pseudo
 * NAME is the record-entry key the lift drops (⚠key — hardening), so the line is
 * pseudo-name-agnostic.
 *
 * ★ `op:"removed"` IS produced today (detach carries `field` = `pseudoVariantGroups`).
 * `op:"enabled"` is NOT yet reachable: birth-placement is invisible under the current
 * `recognizeBirth` contract (see header), so a pseudo-group ADD currently surfaces as the
 * generic `VariantAxisChanged:added` (still truthful — a pseudo group IS an axis). The
 * `"enabled"` arm lights up once integration gives birth-placement (cut-access or a
 * `ctx.placementOf` helper) — kept in the union so the kind stays complete (clay).
 */
export interface PseudoStateStylingChanged extends IntentEventBase {
  kind: "PseudoStateStylingChanged";
  op: "enabled" | "removed";
  /** the owning component name (via the owner walk). */
  component: string;
}

/**
 * Variant precedence (override order) was reordered — a `variantPrecedence` list
 * reorder on a Component or the Site. The lift emits a direction-less `reorder` (no
 * index yet, hardening §4.3#2), so the line names no specific pair.
 */
export interface VariantPrecedenceReordered extends IntentEventBase {
  kind: "VariantPrecedenceReordered";
  /** the owning component name, or "site-wide" for the Site-level precedence. */
  owner: string;
}

/** Every intent kind the Variants & Environments area owns. */
export type VariantsIntent =
  | VariantAxisChanged
  | VariantChanged
  | PseudoStateStylingChanged
  | VariantPrecedenceReordered;

// ─────────────────────────────────────────────────────────────────────────────
// The area module
// ─────────────────────────────────────────────────────────────────────────────

export const variantsArea: AreaModule = {
  name: "Variants",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta, fresh: Set<string>): VariantsIntent | null {
    const t = root.entity.type;
    const u = root.entity.uuid;

    // A fresh VariantGroup = a new variance axis. Its variants + subject ref are
    // co-fresh / co-cut and MERGE centrally. The axis name reads via nameOf
    // (VariantGroup.name is subject-derived → correct here without dereferencing subject).
    if (isVariantGroup(t)) {
      const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

      // ★ Placement (pseudo / site / component) is NOT discriminable at BIRTH under the
      // current contract — `recognizeBirth` is handed the `materialized` change, not the
      // cut, so we cannot read the group's own `reparent.field` (= the parent child-list
      // key). See header + the integrate flag. So at birth we cannot split
      // PseudoStateStylingChanged:enabled out from a generic axis add (the pseudo NAME is
      // a dropped record key regardless — hardening ⚠key). BEST-EFFORT signal we DO have:
      // `ownerOf` finds the owning Component; a SITE-level (global) group has no Component
      // ancestor → `ownerOf` returns undefined. Use that for the `global` flag only.
      // (Sound: a pseudo group still IS a variance axis, so "Added variance axis" is
      // truthful, just less specific than "Enabled :hover styling". Removal IS correctly
      // discriminated — detach carries `field`.) `fresh` is unused here for the same
      // contract reason; kept in the signature for parity / future cut access.
      void fresh;
      const global = ctx.ownerOf ? ctx.ownerOf(u, meta.seq) === undefined : false;
      return {
        kind: "VariantAxisChanged",
        subKind: "added",
        axis: name(ctx, u, meta.seq),
        ...(global ? { global: true } : {}),
        ...base,
      };
    }

    // A fresh Variant under a NON-fresh VariantGroup = a variant added to an existing
    // axis (hardening §1.7). Under a FRESH group it's a fresh descendant → already
    // merged by the pipeline, so this only fires for the add-to-existing case. The
    // condition (operator / right) is birth payload (merged); we surface the add.
    if (isVariant(t)) {
      return {
        kind: "VariantChanged",
        subKind: "added",
        variant: name(ctx, u, meta.seq),
        group: owner(ctx, u, meta.seq),
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // VariantsCombination — CONSCIOUSLY not owned at birth (cross-area; see header).
    return null;
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): VariantsIntent | null {
    const t = c.entity.type;
    const u = c.entity.uuid;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

    // ── VariantGroup (axis) edits ─────────────────────────────────────────────
    if (isVariantGroup(t)) {
      // Rename. (Birth `name` set is FRESH → never reaches recognizeEdit.)
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "VariantAxisChanged", subKind: "renamed", axis: str(c.after), from: str(c.before), ...base };
      }
      // `standalone` flip = toggle-mode (single on/off ↔ multi-option choice).
      if (c.verb === "set" && c.field === "standalone" && c.before !== undefined) {
        return { kind: "VariantAxisChanged", subKind: "toggleMode", axis: name(ctx, u, meta.seq), standalone: c.after === true, ...base };
      }
      // `subject` ref re-pointed = the axis now reacts to a different signal. The new
      // subject is a uuid in `after` (NOT decorate-labeled — hardening §4.3#4); resolve
      // its name via nameOf, else read coarse.
      if (c.verb === "set" && c.field === "subject" && c.before !== undefined) {
        return { kind: "VariantAxisChanged", subKind: "subjectRebound", axis: name(ctx, u, meta.seq), ...base };
      }
      // Promotion (hardening §1.9): a component-local VariantGroup reparented → Site.
      // Gated on entity.type FIRST so it never collides with NodeMoved (Tpl area).
      if (c.verb === "reparent" && c.to?.type === "Site") {
        return { kind: "VariantAxisChanged", subKind: "promoted", axis: name(ctx, u, meta.seq), ...base };
      }
      // Removal. A pseudo-styling group detach (parent field `pseudoVariantGroups`)
      // reads as PseudoStateStylingChanged:removed; any other axis detach is the axis
      // removal. (`from` carries the prior parent; `field` = the child-list key.)
      if (c.verb === "detach") {
        if (c.field === PSEUDO_FIELD) {
          return { kind: "PseudoStateStylingChanged", op: "removed", component: ownerOfDetached(ctx, c, meta.seq), ...base };
        }
        return { kind: "VariantAxisChanged", subKind: "removed", axis: name(ctx, u, meta.seq), ...base };
      }
    }

    // ── Variant (option) edits ────────────────────────────────────────────────
    if (isVariant(t)) {
      // Rename.
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "VariantChanged", subKind: "renamed", variant: str(c.after), from: str(c.before), group: owner(ctx, u, meta.seq), ...base };
      }
      // Description set/clear. The Variant is NON-fresh here (birth is skipped), so ANY
      // `set`/`clear` on `description` is a real authoring edit — we deliberately do NOT
      // gate on `before`: a first description (null→text) lifts as a `set` with NO before
      // (Plexus stores null as attr-delete — hardening), and the central ∅→X salience drop
      // would otherwise swallow this genuine gesture. Claiming it here keeps coverage TOTAL.
      if (c.field === "description" && (c.verb === "set" || c.verb === "clear")) {
        return { kind: "VariantChanged", subKind: "description", variant: name(ctx, u, meta.seq), group: owner(ctx, u, meta.seq), ...base };
      }
      // Condition: the `operator` scalar changed (right is a @syncing.child — its
      // materialize/detach rides as a child birth/detach, MERGE/RawEdit; the operator
      // set is the legible condition signal). Birth `operator ∅→null` is FRESH → dropped.
      if (c.verb === "set" && c.field === "operator" && c.before !== undefined) {
        return {
          kind: "VariantChanged",
          subKind: "condition",
          variant: name(ctx, u, meta.seq),
          group: owner(ctx, u, meta.seq),
          operatorPhrase: operatorPhrase(c.after),
          ...base,
        };
      }
      // Removal.
      if (c.verb === "detach") {
        return { kind: "VariantChanged", subKind: "removed", variant: name(ctx, u, meta.seq), group: owner(ctx, u, meta.seq), ...base };
      }
    }

    // ── variantPrecedence reorder (Component or Site) ─────────────────────────
    // `@syncing.list` of VariantGroup refs; a reorder is the override-order edit. The
    // entity here is the OWNER (Component / Site), not a variance entity, so route by
    // FIELD. Direction-less (lift carries no index — hardening §4.3#2).
    if (c.verb === "reorder" && c.field === "variantPrecedence") {
      const isSite = t === "Site";
      return { kind: "VariantPrecedenceReordered", owner: isSite ? "site-wide" : name(ctx, u, meta.seq), ...base };
    }

    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "VariantAxisChanged":
        switch (e.subKind) {
          case "added":
            return e.global
              ? `Added the site-wide variance axis "${e.axis}"` // DRAFT — V review
              : `Added the variance axis "${e.axis}"`; // DRAFT — V review
          case "removed":
            return `Removed the variance axis "${e.axis}"`; // DRAFT — V review
          case "renamed":
            return `Renamed variance axis "${e.from}" → "${e.axis}"`; // DRAFT — V review
          case "toggleMode":
            return e.standalone
              ? `Axis "${e.axis}" is now a single on/off toggle` // DRAFT — V review
              : `Axis "${e.axis}" is now a multi-option choice`; // DRAFT — V review
          case "subjectRebound":
            return `Axis "${e.axis}" now reacts to a different signal`; // DRAFT — V review (subject ref unlabeled — §4.3#4)
          case "promoted":
            return `Promoted variance axis "${e.axis}" to site-wide`; // DRAFT — V review
          default:
            return null;
        }
      case "VariantChanged":
        switch (e.subKind) {
          case "added":
            return `Added variant "${e.variant}" to "${e.group}"`; // DRAFT — V review
          case "removed":
            return `Removed variant "${e.variant}" from "${e.group}"`; // DRAFT — V review
          case "renamed":
            return `Renamed variant "${e.from}" → "${e.variant}"`; // DRAFT — V review
          case "condition":
            return `Variant "${e.variant}" now matches when ${e.group} ${e.operatorPhrase} a value`; // DRAFT — V review (right unlabeled — §4.3#4)
          case "description":
            return `Described variant "${e.variant}"`; // DRAFT — V review
          default:
            return null;
        }
      case "PseudoStateStylingChanged":
        return e.op === "enabled"
          ? `Enabled pseudo-state styling on "${e.component}"` // DRAFT — V review (pseudo name ⚠key — §4.3#1)
          : `Removed pseudo-state styling from "${e.component}"`; // DRAFT — V review
      case "VariantPrecedenceReordered":
        return e.owner === "site-wide"
          ? `Reordered the site-wide variant precedence` // DRAFT — V review
          : `Reordered variant precedence on "${e.owner}"`; // DRAFT — V review
      default:
        return null;
    }
  },
};

/** Owning component name for a DETACHED group: prefer the detach `from` (prior parent), else the owner walk. */
function ownerOfDetached(ctx: LensCtx, c: PlexusChange, seq: number): string {
  if (c.from) return ctx.nameOf(c.from.uuid, seq) ?? "?";
  return owner(ctx, c.entity.uuid, seq);
}
