import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Tpl tree structure  (design §1 "Tpl tree structure", §3 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * The render-tree node lifecycle + structure: a component's `tplTree` is a tree of
 * TplTag (HTML element) / TplComponent (an instance of another component) / TplSlot
 * (a slot definition). This area owns NON-birth node edits and the STANDALONE node
 * add / move / remove — the cases the central component-birth cascade does NOT absorb.
 *
 * Entity types this area OWNS (the `@syncing("…")` nodeName the lift stamps into
 * `entity.type`; verified against the model source this pass — TplNode.ts):
 *   - "TplTag"        (a real DOM element: `tag`, `name`, `type`, `locked`, `children`, `text`)
 *   - "TplComponent"  (an instance of a Component: `name`, `component`, `slots`, `propSpreads`)
 *   - "TplSlot"       (a slot DEFINITION inside a component: `param`, `defaultContents`)
 *   - the text aspect subtree of a TplTag (verified TextSet.ts / RawText.ts / ExprText.ts):
 *       "TextSet"  (the per-combo text wrapper; `text: RichText | null`)
 *       "RawText"  (literal rich text; `text: string`, `markers: Marker[]`)
 *       "ExprText" (text bound to an expression; `expr`, `html: boolean`)
 *       "NodeMarker" / "StyleMarker" (inline runs inside a RawText)
 *
 * ── How the CENTRAL pipeline frames births (consolidate.ts) ──────────────────
 * A `materialized` whose parent (recovered from its same-cut `reparent.to`) is ALSO
 * fresh is a fresh DESCENDANT → absorbed (the component-birth root TplTag never reaches
 * us; CARD's root tag MERGEs into ComponentAdded). A `materialized` whose parent is
 * NON-fresh (or unrecovered) is a BIRTH ROOT → offered to `recognizeBirth`. So:
 *   - the root TplTag of a brand-new component  → absorbed centrally (NOT ours)
 *   - a TplTag/TplComponent/TplSlot inserted into an EXISTING tree → our NodeAdded
 * This is exactly the hardening §1.7 "fresh child of a non-fresh parent" class, here in
 * its node-tree form: it IS an add (a real NodeAdded), not a spurious one.
 *
 * ── The reparent gate (hardening §1.9) ──────────────────────────────────────
 * `recognizeEdit` sees `reparent` for MANY entity types (ArenaFrame moves, VariantGroup
 * promotion, …). We gate NodeMoved on `entity.type ∈ {TplTag,TplComponent,TplSlot}` so a
 * cross-area reparent never mis-fires here. A reparent WITHOUT `from` is a first parent-
 * assign (birth placement) → not a move (and the entity is fresh anyway → never reaches us).
 *
 * ── Same-parent reorder (hardening §3.2 / lift C3) ──────────────────────────
 * The lift now emits a real `reorder` verb when a Y.Array element is both inserted AND
 * removed on one list in a cut (C3 pairing). For a tpl child-list (`children` /
 * `defaultContents`) that is a sibling reorder → NodeReordered. No index is carried
 * (lift TODO), so the line is direction-less.
 *
 * ── Boundary calls (where the cut crosses into a neighbouring area) ──────────
 *   - A node's RuleSet / attrs / eventHandlers / args / dataRep / motionAnimations are
 *     OTHER areas (Styling / Behavior / Params / Repeat / Motion). We own only the node
 *     itself + its tag/name/type/locked scalars + its text aspect.
 *   - `propSpreads` is the SpreadChanged feature (design lists it under Tpl, but it is a
 *     distinct prop-bag concern); we leave its entity births/edits to RawEdit here and
 *     defer the dedicated SpreadChanged kind to a later pass (consciously RawEdit — below).
 *   - `TplComponent.component` (which component an instance points at) and `TplSlot.param`
 *     (which slot a definition is for) are set at BIRTH (absorbed). A later re-point is
 *     rare and ref-valued (an unlabeled uuid in `after`, hardening §4.3#4) → RawEdit.
 */

// ── Entity-type sets (the @syncing nodeNames) ────────────────────────────────
const TPL_NODE_TYPES = new Set(["TplTag", "TplComponent", "TplSlot"]);
const isTplNode = (t: string): boolean => TPL_NODE_TYPES.has(t);

// The text-aspect subtree of a TplTag (TplTag.text → TextSet → RawText | ExprText → markers).
const TEXT_TYPES = new Set(["TextSet", "RawText", "ExprText", "NodeMarker", "StyleMarker"]);

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
const name = (ctx: LensCtx, uuid: string, seq: number): string | undefined => ctx.nameOf(uuid, seq);

/** The human noun for a node KIND (its `entity.type`). DRAFT — V review (wording). */
function nodeNoun(t: string): string {
  switch (t) {
    case "TplComponent":
      return "instance"; // DRAFT — V review ("a Card instance")
    case "TplSlot":
      return "slot"; // DRAFT — V review (a slot DEFINITION)
    default:
      return "element"; // TplTag — a <div>/<button>/… DRAFT — V review
  }
}

/**
 * A node's display label, point-in-time. TplTag/TplComponent carry a `name` (often null —
 * only the root is auto-named "root"; most nodes are unnamed); TplSlot has none. We surface
 * the authored name when present, else fall back to the kind noun (we cannot see the `tag`
 * string or the referenced component name from `nameOf` alone — those ride in birth-merged
 * `set tag` / ref-valued `component` the pipeline absorbs; resolving them is deferred, same
 * shape as StateAdded.friendlyType being left null). DRAFT — V review.
 */
function nodeLabel(ctx: LensCtx, uuid: string, type: string, seq: number): string {
  return name(ctx, uuid, seq) ?? nodeNoun(type);
}

/** The owning component/page name (resolved via the owner walk), for "in {owner}". */
function owner(ctx: LensCtx, uuid: string, seq: number): string | undefined {
  if (!ctx.ownerOf) return undefined;
  const o = ctx.ownerOf(uuid, seq);
  return o ? name(ctx, o, seq) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent-kind TYPES (design §1 "Tpl tree structure" block)
// ─────────────────────────────────────────────────────────────────────────────

/** A render-tree node was added to an existing tree (TplTag / TplComponent / TplSlot). */
export interface NodeAdded extends IntentEventBase {
  kind: "NodeAdded";
  /** element (TplTag) · instance (TplComponent) · slot (TplSlot). */
  nodeKind: "element" | "instance" | "slot";
  /** authored name when present, else the kind noun (tag string / target component deferred — see header). */
  label: string;
  /** the parent node/owner the node landed under (the reparent `to`), resolved; undefined if unrecovered. */
  parent?: string;
}

/** A render-tree node was removed (detached from its parent). Label resolved point-in-time. */
export interface NodeRemoved extends IntentEventBase {
  kind: "NodeRemoved";
  nodeKind: "element" | "instance" | "slot";
  label: string;
  /** the parent it was detached FROM (the detach `from`), resolved; undefined if unrecovered. */
  from?: string;
}

/** A render-tree node was moved to a different parent (reparent WITH a prior parent). */
export interface NodeMoved extends IntentEventBase {
  kind: "NodeMoved";
  nodeKind: "element" | "instance" | "slot";
  label: string;
  from?: string;
  to?: string;
}

/** A node's children/defaultContents list was reordered (same-parent C3 reorder; direction-less). */
export interface NodeReordered extends IntentEventBase {
  kind: "NodeReordered";
  /** the owning node whose child list reordered, resolved. */
  parent: string;
}

/** A node was renamed (its authored `name` set/changed; TplTag/TplComponent only). */
export interface NodeRenamed extends IntentEventBase {
  kind: "NodeRenamed";
  nodeKind: "element" | "instance" | "slot";
  from: string;
  to: string;
}

/** A TplTag's HTML tag changed (`<div>` → `<section>`); `before` present = a real retag. */
export interface TagChanged extends IntentEventBase {
  kind: "TagChanged";
  label: string;
  from?: string;
  to: string;
}

/** A TplTag's SEMANTIC type changed (TplTagType: text / image / plain container). */
export interface TagSemanticTypeChanged extends IntentEventBase {
  kind: "TagSemanticTypeChanged";
  label: string;
  /** "text" · "image" · "container" (null = a plain container). */
  semantic: "text" | "image" | "container";
}

/** A node's `locked` flag flipped (locked = not editable on the canvas). */
export interface NodeLocked extends IntentEventBase {
  kind: "NodeLocked";
  label: string;
  locked: boolean;
}

/** A TplTag's text content changed (RawText literal / ExprText binding / raw-HTML toggle / inline run). */
export interface TextChanged extends IntentEventBase {
  kind: "TextChanged";
  /** set — literal text set; bound — text bound to an expression; rawHtml — raw-HTML allowed toggled; inline — an inline run (marker) edited. */
  what: "set" | "bound" | "rawHtml" | "inline";
  /** the owning TplTag's label (resolved via the owner walk; undefined if unrecovered). */
  node?: string;
  /** the literal text excerpt (what === "set"); the new rawHtml state (what === "rawHtml"). */
  detail?: string;
}

/** Every intent kind the Tpl-tree area owns. */
export type TplTreeIntent =
  | NodeAdded
  | NodeRemoved
  | NodeMoved
  | NodeReordered
  | NodeRenamed
  | TagChanged
  | TagSemanticTypeChanged
  | NodeLocked
  | TextChanged;

// ─────────────────────────────────────────────────────────────────────────────
// The area module
// ─────────────────────────────────────────────────────────────────────────────

const nodeKindOf = (t: string): "element" | "instance" | "slot" =>
  t === "TplComponent" ? "instance" : t === "TplSlot" ? "slot" : "element";

export const tplTreeArea: AreaModule = {
  name: "Tpl tree structure",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): NodeAdded | null {
    // A fresh TplTag/TplComponent/TplSlot whose parent is NON-fresh (the pipeline already
    // filtered fresh-descendants) = a node added into an EXISTING tree → NodeAdded.
    // (The root tag of a brand-new component is a fresh descendant of the fresh component →
    // absorbed centrally; it never reaches here.)
    if (!isTplNode(root.entity.type)) return null;
    // The node's parent THIS cut rides on its own reparent (verb:"reparent", to=parent). We
    // don't get it as an argument, so resolve the placement target via the owner walk instead.
    const parentName = owner(ctx, root.entity.uuid, meta.seq);
    return {
      kind: "NodeAdded",
      nodeKind: nodeKindOf(root.entity.type),
      label: nodeLabel(ctx, root.entity.uuid, root.entity.type, meta.seq),
      ...(parentName !== undefined ? { parent: parentName } : {}),
      sourceUuids: meta.sourceUuids,
      seq: meta.seq,
      timestamp: meta.timestamp,
      author: meta.author,
    };
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): TplTreeIntent | null {
    const t = c.entity.type;
    const u = c.entity.uuid;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

    // ── Node MOVE / REMOVE / REORDER (gate on entity.type FIRST — hardening §1.9) ──
    if (isTplNode(t)) {
      // reparent WITH a prior parent (`from` present) = a genuine move. (First parent-assign
      // has no `from` and the entity would be fresh anyway → not seen here.)
      if (c.verb === "reparent" && c.from) {
        return {
          kind: "NodeMoved",
          nodeKind: nodeKindOf(t),
          label: nodeLabel(ctx, u, t, meta.seq),
          ...(c.from ? { from: name(ctx, c.from.uuid, meta.seq) ?? c.from.type } : {}),
          ...(c.to ? { to: name(ctx, c.to.uuid, meta.seq) ?? c.to.type } : {}),
          ...base,
        };
      }
      // detach = removed from the tree. Name resolved point-in-time (it's gone from the live tree).
      if (c.verb === "detach") {
        return {
          kind: "NodeRemoved",
          nodeKind: nodeKindOf(t),
          label: nodeLabel(ctx, u, t, meta.seq),
          ...(c.from ? { from: name(ctx, c.from.uuid, meta.seq) ?? c.from.type } : {}),
          ...base,
        };
      }
      // C3 same-parent reorder of a child list (children / defaultContents). Direction-less
      // (no index in the lift yet). `field` = the reordered list key; the entity IS the parent.
      if (c.verb === "reorder" && (c.field === "children" || c.field === "defaultContents")) {
        return { kind: "NodeReordered", parent: nodeLabel(ctx, u, t, meta.seq), ...base };
      }
    }

    // ── TplTag scalar edits ────────────────────────────────────────────────────
    if (t === "TplTag") {
      // `tag` change (the HTML element). before-present = a real retag (a ∅→tag birth set is
      // absorbed since the entity is fresh; defensively require before so we never read a birth).
      if (c.verb === "set" && c.field === "tag" && c.before !== undefined) {
        return { kind: "TagChanged", label: nodeLabel(ctx, u, t, meta.seq), from: str(c.before), to: str(c.after), ...base };
      }
      // `type` — the SEMANTIC type (TplTagType: "text" | "image" | null). A clear or set→null
      // means "plain container"; "text"/"image" are the typed forms.
      if (c.field === "type" && (c.verb === "set" || c.verb === "clear")) {
        const v = c.verb === "clear" ? null : c.after;
        const semantic = v === "text" ? "text" : v === "image" ? "image" : "container";
        return { kind: "TagSemanticTypeChanged", label: nodeLabel(ctx, u, t, meta.seq), semantic, ...base };
      }
    }

    // ── Node rename (TplTag / TplComponent `name`; before-present = a rename, not a birth) ──
    if ((t === "TplTag" || t === "TplComponent") && c.verb === "set" && c.field === "name" && c.before !== undefined) {
      return { kind: "NodeRenamed", nodeKind: nodeKindOf(t), from: str(c.before), to: str(c.after), ...base };
    }

    // ── locked flip (on any node; before-present so a ∅→false birth default doesn't fire) ──
    if (isTplNode(t) && c.field === "locked" && (c.verb === "set" || c.verb === "clear") && c.before !== undefined) {
      return { kind: "NodeLocked", label: nodeLabel(ctx, u, t, meta.seq), locked: c.verb === "set" && c.after === true, ...base };
    }

    // ── Text aspect (TplTag.text → TextSet → RawText | ExprText → markers) ──────
    // RawText.text literal set/changed → the text content. (A ∅→text first write at birth is a
    // fresh RawText → absorbed; here it's an edit of existing literal text.)
    if (t === "RawText" && c.field === "text" && c.verb === "set") {
      return { kind: "TextChanged", what: "set", node: owner(ctx, u, meta.seq), detail: str(c.after), ...base };
    }
    // ExprText.html toggle (allow raw HTML when rendering an expression).
    if (t === "ExprText" && c.field === "html" && (c.verb === "set" || c.verb === "clear")) {
      return { kind: "TextChanged", what: "rawHtml", node: owner(ctx, u, meta.seq), detail: String(c.verb === "set" && c.after === true), ...base };
    }
    // ExprText.expr (re)bound — text driven by an expression. The expr is a ref/child; we don't
    // surface its body (low-detail, lives in another area), just the fact that text is now bound.
    if (t === "ExprText" && c.field === "expr" && (c.verb === "set" || c.verb === "clear")) {
      return { kind: "TextChanged", what: "bound", node: owner(ctx, u, meta.seq), ...base };
    }
    // An inline run inside a RawText (NodeMarker = an inline element; StyleMarker = a styled
    // span). Any edit/detach on a marker reads as "a run of text was edited" — coarse but TOTAL.
    if ((t === "NodeMarker" || t === "StyleMarker") && (c.verb === "set" || c.verb === "clear" || c.verb === "detach")) {
      return { kind: "TextChanged", what: "inline", node: owner(ctx, u, meta.seq), ...base };
    }

    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "NodeAdded": {
        const noun = e.nodeKind === "instance" ? "instance" : e.nodeKind === "slot" ? "slot" : "element";
        const where = e.parent ? ` to ${e.parent}` : "";
        return `Added ${noun} "${e.label}"${where}`; // DRAFT — V review
      }
      case "NodeRemoved": {
        const noun = e.nodeKind === "instance" ? "instance" : e.nodeKind === "slot" ? "slot" : "element";
        const where = e.from ? ` from ${e.from}` : "";
        return `Removed ${noun} "${e.label}"${where}`; // DRAFT — V review
      }
      case "NodeMoved": {
        const dest = e.to ? ` into ${e.to}` : "";
        const src = e.from ? ` from ${e.from}` : "";
        return `Moved "${e.label}"${src}${dest}`; // DRAFT — V review
      }
      case "NodeReordered":
        return `Reordered the children of ${e.parent}`; // DRAFT — V review
      case "NodeRenamed": {
        const noun = e.nodeKind === "instance" ? "instance" : e.nodeKind === "slot" ? "slot" : "element";
        return `Renamed ${noun} "${e.from}" → "${e.to}"`; // DRAFT — V review
      }
      case "TagChanged":
        return `Changed "${e.label}" from <${e.from ?? "?"}> to <${e.to}>`; // DRAFT — V review
      case "TagSemanticTypeChanged":
        return e.semantic === "text"
          ? `Turned "${e.label}" into a text block` // DRAFT — V review
          : e.semantic === "image"
            ? `Turned "${e.label}" into an image` // DRAFT — V review
            : `Turned "${e.label}" into a plain container`; // DRAFT — V review
      case "NodeLocked":
        return e.locked ? `Locked "${e.label}"` : `Unlocked "${e.label}"`; // DRAFT — V review
      case "TextChanged": {
        const on = e.node ? ` of ${e.node}` : "";
        if (e.what === "set") return `Set text${on} to "${e.detail ?? ""}"`; // DRAFT — V review
        if (e.what === "bound") return `Bound text${on} to an expression`; // DRAFT — V review
        if (e.what === "rawHtml")
          return e.detail === "true" ? `Allowed raw HTML in the text${on}` : `Disallowed raw HTML in the text${on}`; // DRAFT — V review
        return `Edited a run of text${on}`; // DRAFT — V review (inline marker)
      }
      default:
        return null;
    }
  },
};
