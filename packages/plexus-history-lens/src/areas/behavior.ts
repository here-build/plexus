import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Behavior / Interactions / Expressions   (design §1 "Behavior …", §3 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * What a node DOES: event handlers, reactive (signal/lifecycle) handlers, the
 * interaction steps inside them, navigation, operation-invocation, and the
 * expression edits behind bindings.
 *
 * Entity types this area OWNS (entity.type = the model nodeName; class names verified
 * against public-packages/model/src/models/{behavior,exprs} this pass):
 *   - "EventHandler"        a handler attached to an element event (ROOT — WiredEventHandler)
 *   - "SignalHandler"       a reactive/lifecycle/mount handler   (ROOT — ReactiveHandlerAdded)
 *   - "EventHandlersSet"    the per-element handler bag (container; its entries carry meaning)
 *   - "InteractionStep"     one step inside a handler
 *   - "ActionIntent"        a step's action
 *   - "NavigationAction"    a navigate action (target / newTab)
 *   - "CustomFunctionAction" a custom-code action
 *   - "InvokeOperation"     a call-operation action (operation ref + bound args)
 *   - "InvalidateQueryAction" a refresh-queries action
 *   - "CollectionExpr"/"MapExpr"/"StyleExpr"/"ExprText" expression nodes behind bindings
 *
 * ── Pipeline framing (consolidate.ts) ────────────────────────────────────────
 * An EventHandler/SignalHandler is attached to an EXISTING element (the element is not
 * fresh) → the handler is a BIRTH ROOT → recognizeBirth. Its own internal cascade
 * (InteractionStep/ActionIntent materializations under the fresh handler) are fresh
 * descendants → absorbed centrally into the WiredEventHandler/ReactiveHandlerAdded root.
 * So recognizeEdit only sees edits to ALREADY-EXISTING handlers/steps/exprs.
 *
 * ── Known limitation (flagged) ───────────────────────────────────────────────
 * WiredEventHandler wants the EVENT name (onClick/onHover). That rides on the handler's
 * \0-tuple[1] (the EventHandlersSet child-list key, now surfaced by C5) — but on the
 * handler's REPARENT change, not its materialize, and recognizeBirth only receives the
 * materialize. Until the pipeline passes co-cut sibling context to recognizeBirth, the
 * event name is omitted (generic "a handler"). Tracked; see consolidate.ts.
 *
 * ── Boundary calls ───────────────────────────────────────────────────────────
 *   - QueryInvalidationChanged / InvokeOperation arg-binding straddle Data — we emit the
 *     behavior-side intent (an action was wired); the query/operation identity is Data's.
 *   - Long tail (HandlerInternalsChanged phase/concurrency/signals, CustomCodeActionEdited
 *     body) → RawEdit for now (coverage holds; promote in a feedback pass).
 */

const HANDLER_ROOTS = new Set(["EventHandler", "SignalHandler"]);
const STEP_TYPES = new Set(["InteractionStep", "ActionIntent"]);
const EXPR_TYPES = new Set(["CollectionExpr", "MapExpr", "StyleExpr", "ExprText"]);
const isHandlerRoot = (t: string): boolean => HANDLER_ROOTS.has(t);

const stamp = (meta: CutMeta): Pick<IntentEventBase, "sourceUuids" | "seq" | "timestamp" | "author"> => ({
  sourceUuids: meta.sourceUuids,
  seq: meta.seq,
  timestamp: meta.timestamp,
  author: meta.author,
});

/** A behavior was attached to an element (event handler) or to a signal/lifecycle (reactive handler). */
export interface BehaviorAdded extends IntentEventBase {
  kind: "BehaviorAdded";
  handlerKind: "event" | "reactive";
  targetLabel: string; // the owning element/component (via the owner walk)
  event?: string; // the event name (onClick/…) — omitted until the pipeline passes co-cut context (see header)
}

/** An interaction step inside an existing handler changed (added/renamed/action/condition). */
export interface InteractionStepChanged extends IntentEventBase {
  kind: "InteractionStepChanged";
  subKind: "added" | "renamed" | "actionKind" | "condition" | "edited";
  label: string;
}

/** A navigate action's destination or new-tab flag changed. */
export interface NavigationChanged extends IntentEventBase {
  kind: "NavigationChanged";
  subKind: "target" | "newTab";
  to?: string;
}

/** An expression behind a binding was edited (collection / map / style / text expr). */
export interface ExpressionEdited extends IntentEventBase {
  kind: "ExpressionEdited";
  exprKind: string; // the Expr nodeName, lens-lexicon-mapped — DRAFT
  targetLabel: string;
}

/** A handler (and its step subtree) was removed from an element/signal. */
export interface BehaviorRemoved extends IntentEventBase {
  kind: "BehaviorRemoved";
  handlerKind: "event" | "reactive";
  targetLabel: string;
}

export type BehaviorIntent =
  | BehaviorAdded
  | InteractionStepChanged
  | NavigationChanged
  | ExpressionEdited
  | BehaviorRemoved;

const ownerLabel = (ctx: LensCtx, uuid: string, seq: number): string =>
  (ctx.ownerOf ? ctx.nameOf(ctx.ownerOf(uuid, seq) ?? "", seq) : undefined) ?? ctx.nameOf(uuid, seq) ?? "an element";

export const behaviorArea: AreaModule = {
  name: "Behavior",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): BehaviorAdded | null {
    if (!isHandlerRoot(root.entity.type)) return null;
    return {
      kind: "BehaviorAdded",
      handlerKind: root.entity.type === "SignalHandler" ? "reactive" : "event",
      targetLabel: ownerLabel(ctx, root.entity.uuid, meta.seq),
      ...stamp(meta),
    };
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): BehaviorIntent | null {
    // Handler subtree removed (the handler detached from its element/signal).
    if (c.verb === "detach" && isHandlerRoot(c.entity.type)) {
      return {
        kind: "BehaviorRemoved",
        handlerKind: c.entity.type === "SignalHandler" ? "reactive" : "event",
        targetLabel: ctx.nameOf(c.entity.uuid, meta.seq) ?? "an element",
        ...stamp(meta),
      };
    }
    // Navigation action: target or newTab. (field names per design §1 — verify vs NavigationAction.ts)
    if (c.verb === "set" && c.entity.type === "NavigationAction") {
      const subKind = c.field === "openInNewTab" || c.field === "newTab" ? "newTab" : "target";
      const to = subKind === "target" && typeof c.after === "string" ? c.after : undefined;
      return { kind: "NavigationChanged", subKind, ...(to ? { to } : {}), ...stamp(meta) };
    }
    // Interaction step edits on an EXISTING step (a fresh step under a fresh handler is absorbed).
    if (STEP_TYPES.has(c.entity.type)) {
      const subKind =
        c.verb === "set" && c.field === "name"
          ? "renamed"
          : c.verb === "set" && (c.field === "actionName" || c.field === "interactionName")
            ? "actionKind"
            : c.verb === "set" && c.field === "condition"
              ? "condition"
              : "edited";
      return { kind: "InteractionStepChanged", subKind, label: ctx.nameOf(c.entity.uuid, meta.seq) ?? "a step", ...stamp(meta) };
    }
    // Expression behind a binding edited.
    if (EXPR_TYPES.has(c.entity.type) && (c.verb === "set" || c.verb === "clear")) {
      return {
        kind: "ExpressionEdited",
        exprKind: c.entity.type, // DRAFT — map to a lens lexicon ("collection"/"map"/"style"/"text")
        targetLabel: ownerLabel(ctx, c.entity.uuid, meta.seq),
        ...stamp(meta),
      };
    }
    // Long tail (HandlerInternalsChanged / CustomCodeActionEdited / InvokeOperation arg-binding /
    // QueryInvalidationChanged) → RawEdit for now. Coverage holds; promote in a feedback pass.
    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "BehaviorAdded":
        return e.handlerKind === "reactive"
          ? `Added a reactive handler on "${e.targetLabel}"` // DRAFT — V review
          : `Wired ${e.event ? `the ${e.event} handler` : "a handler"} on "${e.targetLabel}"`; // DRAFT — V review
      case "InteractionStepChanged":
        return e.subKind === "renamed"
          ? `Renamed interaction step "${e.label}"` // DRAFT — V review
          : `Changed interaction step "${e.label}" (${e.subKind})`; // DRAFT — V review
      case "NavigationChanged":
        return e.subKind === "newTab"
          ? `Changed a navigation's new-tab behavior` // DRAFT — V review
          : `Set a navigation target${e.to ? ` to ${e.to}` : ""}`; // DRAFT — V review
      case "ExpressionEdited":
        return `Edited the ${e.exprKind} expression on "${e.targetLabel}"`; // DRAFT — V review
      case "BehaviorRemoved":
        return e.handlerKind === "reactive"
          ? `Removed a reactive handler from "${e.targetLabel}"` // DRAFT — V review
          : `Removed a handler from "${e.targetLabel}"`; // DRAFT — V review
      default:
        return null;
    }
  },

  // Pass-2 fragment (lens-architecture.md §4/§6): the bare facet phrase under "{element} gets … {coordinate}".
  // Wiring a handler is the §4 flagship's "additional click handler" — an additive NOUN acquisition. A step
  // ADDED to an existing handler reads likewise; edits (rename / condition / navigation / expression) and a
  // handler REMOVAL are non-additive → `null` (standalone `humanize`, pending the Pass-2 verb model). DRAFT.
  fragment(e): string | null {
    switch (e.kind) {
      case "BehaviorAdded":
        return e.handlerKind === "reactive" ? "a reactive handler" : `a ${e.event ? `${e.event} ` : ""}handler`; // DRAFT
      case "InteractionStepChanged":
        return e.subKind === "added" ? "an interaction step" : null; // DRAFT — edits are standalone
      default:
        return null; // NavigationChanged / ExpressionEdited / BehaviorRemoved → standalone humanize. DRAFT
    }
  },
};
