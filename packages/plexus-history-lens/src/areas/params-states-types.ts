import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Params / States / Types  (design §1 "Params / States / Types", §3 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * The component/callable INTERFACE surface: a component's States (variables / props /
 * derivations) and the *type shapes* that describe them — the value-types a State or
 * an arg slot carries, the arg-shape trees (ArgSlot/Record/Tuple/Switch/Match) of a
 * callable, the return-shape trees (ReturnRecord/Slot), and the type-detail entities
 * (ChoiceOption / Ref / Color / ClassName / ProviderSource / EmitterEvent).
 *
 * Entity types this area OWNS (the `@syncing("…")` nodeName the lift stamps in
 * `entity.type`; verified against the model source this pass):
 *   - State                         (state/State.ts            → "State")
 *   - SlotParam                     (component/SlotParam.ts     → "SlotParam")
 *   - ExposedSpec                   (state/ExposedSpec.ts       → "ExposedSpec")
 *   - ArgSlot / ArgRecord / ArgTuple / ArgSwitch / ArgMatch   (shape/*.ts)
 *   - ReturnRecord / ReturnSlot     (shape/*.ts)
 *   - EventEmitterDecl / EmitterEvent (shape/*.ts)
 *   - the type-detail entities: ChoiceOption ("ChoiceOption"), RefType ("RefType"),
 *     ColorPropType ("ColorPropType"), ClassNamePropType ("ClassNamePropType"),
 *     LabeledSelector ("LabeledSelector"), ProviderSource ("ProviderSource"),
 *     UnionValue ("UnionValue"), CrossFieldRule ("CrossFieldRule")
 *   - the value-/discrimination-TYPE entities living on `State.type` / `ArgSlot.type`:
 *     "Num" "Text" "BoolType" "AnyType" "Choice" "Img" "HrefType" "TargetType"
 *     "DateString" "DateRangeStrings" "QueryData" "ClassNamePropType" "ColorPropType"
 *     "FormType" "FunctionType" "UnionType" "HtmlTag" "ComponentInstance" "PageRefType"
 *     "RefType" — these back the `TypeChanged` / `StateAdded(friendlyType)` rows.
 *
 * Boundary calls (where the cut crosses into a neighbouring area):
 *   - A `State` that IS a variant subject (its discrimination type is owned by a
 *     co-fresh `VariantGroup`) is a Variants-area axis birth, NOT a Params StateAdded
 *     (hardening §1.8 — "Remove {variant group} from StateAdded; let Variants own all
 *     axis births"). We can't see the co-fresh VariantGroup.subject ref from the
 *     `fresh` uuid-set alone, so the DECOMPOSITION is: register the Variants module
 *     BEFORE this one — it folds its co-fresh `State` subject first (first-non-null
 *     wins) and this hook never fires for that root. We emit StateAdded for the
 *     remaining (value-typed) states. See `recognizeBirth`.
 *   - `Variant.right`, `ChoiceType.options` as a UnionValue, etc. are Variants-area.
 *   - The `type` CHILD entities are ours (retype), but a `UnionType` is non-removable
 *     and its `source`/`values` are the Variants feature-flag wire — we own the
 *     `ProviderSource` binding rows; the union's variant membership is Variants'.
 */

// ── friendlyType: the closed IType nodeName → human noun table (hardening §2.1) ──
// DRAFT — V review (wording). Keys are the `@syncing("…")` names the lift emits.
const FRIENDLY_TYPE: Record<string, string> = {
  Num: "number",
  Text: "text",
  BoolType: "true/false",
  AnyType: "anything",
  Choice: "choice",
  Img: "image",
  HrefType: "link",
  TargetType: "link target",
  DateString: "date",
  DateRangeStrings: "date range",
  QueryData: "query result",
  ClassNamePropType: "CSS class",
  ColorPropType: "color",
  FormType: "form",
  FunctionType: "callback",
  UnionType: "set of options",
  HtmlTag: "HTML tag",
  ComponentInstance: "component",
  PageRefType: "page link",
  RefType: "element ref",
};
const TYPE_ENTITY = new Set(Object.keys(FRIENDLY_TYPE));
const isTypeEntity = (t: string): boolean => TYPE_ENTITY.has(t);
const friendlyType = (t: string | undefined): string => (t ? (FRIENDLY_TYPE[t] ?? t) : "untyped");

// Parents a type entity can hang off (State.type / ArgSlot.type) — a retype target.
const RETYPE_PARENTS = new Set(["State", "ArgSlot"]);
// Arg-/Return-shape STRUCTURAL nodes (a fresh one under a non-fresh parent = SlotAdded).
const ARG_SHAPE_NODES = new Set(["ArgSlot", "ArgRecord", "ArgTuple", "ArgSwitch"]);

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
const name = (ctx: LensCtx, uuid: string, seq: number): string => ctx.nameOf(uuid, seq) ?? "?";
const owner = (ctx: LensCtx, uuid: string, seq: number): string =>
  (ctx.ownerOf ? (ctx.nameOf(ctx.ownerOf(uuid, seq) ?? "", seq) ?? "?") : "?");

// ─────────────────────────────────────────────────────────────────────────────
// Intent-kind TYPES (design §1 "Params / States / Types" block)
// ─────────────────────────────────────────────────────────────────────────────

/** A State was added to a Component/Site (a variable / prop / derivation). */
export interface StateAdded extends IntentEventBase {
  kind: "StateAdded";
  name: string;
  /** `null` until a child `type` is read this cut; humanizes to "(a {friendlyType})". */
  friendlyType: string | null;
  /** props (exposed) · variable (internal) · derivation (`represents==="derivation"`). */
  role: "prop" | "variable" | "derivation";
}

/** A State was removed (detached from its owner). Name resolved point-in-time. */
export interface StateRemoved extends IntentEventBase {
  kind: "StateRemoved";
  name: string;
}

/** A State was renamed. */
export interface StateRenamed extends IntentEventBase {
  kind: "StateRenamed";
  from: string;
  to: string;
}

/** A State flipped between exposed-as-prop and internal (`exposed` child set/cleared). */
export interface StateExposureToggled extends IntentEventBase {
  kind: "StateExposureToggled";
  name: string;
  exposed: boolean;
}

/** A State's `represents` flag flipped to/from "derivation". */
export interface StateDerivationMarked extends IntentEventBase {
  kind: "StateDerivationMarked";
  name: string;
  isDerivation: boolean;
}

/** A State / ArgSlot was retyped (its `type` child swapped). `friendlyTo` is the new type. */
export interface TypeChanged extends IntentEventBase {
  kind: "TypeChanged";
  /** owning State/ArgSlot name (resolved via the owner walk; "?" if unresolved). */
  owner: string;
  friendlyTo: string;
}

/** Two-way binding callback (`ExposedSpec.onChange`) set or cleared on a State's prop. */
export interface StateTwoWayBindingChanged extends IntentEventBase {
  kind: "StateTwoWayBindingChanged";
  /** owning State name. */
  state: string;
  bound: boolean;
}

/** A Choice/Union value-domain option was added or removed. */
export interface ChoiceOptionsChanged extends IntentEventBase {
  kind: "ChoiceOptionsChanged";
  /** owning type's owner (State/ArgSlot) name. */
  owner: string;
  op: "added" | "removed";
  /** the option's display label (ChoiceOption.label) or its value. */
  label: string;
}

/** An arg-shape node (ArgSlot/Record/Tuple/Switch) was added under a non-fresh callable. */
export interface SlotAdded extends IntentEventBase {
  kind: "SlotAdded";
  /** arg | record (group) | tuple | switch — the shape-node kind. */
  shape: "arg" | "record" | "tuple" | "switch";
  /** the slot's label (displayName ?? name) or "?". */
  name: string;
  /** the owning callable's name (resolved via the owner walk). */
  owner: string;
}

/** An arg-shape node was removed (detached). */
export interface SlotRemoved extends IntentEventBase {
  kind: "SlotRemoved";
  name: string;
  owner: string;
}

/** An arg-shape list reordered (ArgTuple.items / ArgRecord.fields / FormType.schema). */
export interface SlotReordered extends IntentEventBase {
  kind: "SlotReordered";
  owner: string;
}

/** An ArgSlot's `required` flag flipped. */
export interface SlotRequiredToggled extends IntentEventBase {
  kind: "SlotRequiredToggled";
  name: string;
  required: boolean;
}

/** An ArgSlot's display order (`priority`) changed. */
export interface SlotPriorityChanged extends IntentEventBase {
  kind: "SlotPriorityChanged";
  name: string;
}

/** An ArgSlot's callback `role` flipped (signal source ↔ ordinary callback). */
export interface SlotRoleChanged extends IntentEventBase {
  kind: "SlotRoleChanged";
  name: string;
  asSignal: boolean;
}

/** A slot label/wire-name changed (ArgSlot/ReturnSlot displayName, or SlotParam displayName). */
export interface SlotBindingChanged extends IntentEventBase {
  kind: "SlotBindingChanged";
  /** the new display label (after). */
  to: string;
}

/** An ArgSwitch's arms (ArgMatch) were added/removed — discriminated-union cases. */
export interface ArgSwitchArmsChanged extends IntentEventBase {
  kind: "ArgSwitchArmsChanged";
  op: "added" | "removed";
  /** the arm's literal, rendered domain-aware (null/boolean → phrase). */
  arm: string;
}

/** A callable's return shape changed (ReturnRecord field added/removed, or a read↔write pairing). */
export interface ReturnShapeChanged extends IntentEventBase {
  kind: "ReturnShapeChanged";
  /** "field" — a ReturnSlot/sub-record added/removed; "wiring" — a stateWiring pair edited. */
  what: "field" | "wiring";
  op: "added" | "removed";
  /** field key (when surfaced via the entry-key) or "?". */
  field: string;
}

/** An emitter was declared/edited on a ReturnSlot (event source) or an EmitterEvent changed. */
export interface EmitterChanged extends IntentEventBase {
  kind: "EmitterChanged";
  /** declared — EventEmitterDecl born; event — an EmitterEvent born/retyped. */
  what: "declared" | "event";
  /** node-style vs browser-style (declared); the event name (event). */
  detail: string;
}

/** A ColorPropType deref toggle, or a RefType callbackRef toggle. */
export interface TypeFlagToggled extends IntentEventBase {
  kind: "TypeFlagToggled";
  /** color-deref — keep raw vs resolve through tokens; ref-kind — callback ref vs ref object. */
  flag: "color-deref" | "ref-kind";
  /** the new boolean state, pre-phrased for the flag. */
  on: boolean;
}

/** ClassNamePropType selector list changed (LabeledSelector added/removed/relabelled). */
export interface ClassNameSelectorsChanged extends IntentEventBase {
  kind: "ClassNameSelectorsChanged";
  op: "added" | "removed" | "relabelled";
  /** the selector text (LabeledSelector.selector) or its new label. */
  selector: string;
}

/** A feature-flag provider binding changed (ProviderSource on a UnionType). */
export interface FeatureFlagBindingChanged extends IntentEventBase {
  kind: "FeatureFlagBindingChanged";
  op: "bound" | "unbound" | "remapped";
  /** the provider id (ProviderSource.provider). */
  provider: string;
}

/** A cross-field form rule was added/removed/edited (CrossFieldRule on a FormType). */
export interface FormRuleChanged extends IntentEventBase {
  kind: "FormRuleChanged";
  op: "added" | "removed" | "edited";
}

/** Every intent kind the Params/States/Types area owns. */
export type ParamsStatesTypesIntent =
  | StateAdded
  | StateRemoved
  | StateRenamed
  | StateExposureToggled
  | StateDerivationMarked
  | TypeChanged
  | StateTwoWayBindingChanged
  | ChoiceOptionsChanged
  | SlotAdded
  | SlotRemoved
  | SlotReordered
  | SlotRequiredToggled
  | SlotPriorityChanged
  | SlotRoleChanged
  | SlotBindingChanged
  | ArgSwitchArmsChanged
  | ReturnShapeChanged
  | EmitterChanged
  | TypeFlagToggled
  | ClassNameSelectorsChanged
  | FeatureFlagBindingChanged
  | FormRuleChanged;

// ─────────────────────────────────────────────────────────────────────────────
// The area module
// ─────────────────────────────────────────────────────────────────────────────

export const paramsStatesTypesArea: AreaModule = {
  name: "Params/States/Types",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): ParamsStatesTypesIntent | null {
    const t = root.entity.type;

    // A State birth → StateAdded. (Variant-subject States are claimed first by the
    // Variants area folding their co-fresh VariantGroup — see header. We can't see the
    // sibling VariantGroup from `fresh`, so we rely on registry order; whatever reaches
    // us is a value-typed State.)
    if (t === "State") {
      // `friendlyType` would come from this State's co-fresh child `type` entity; the
      // pipeline already MERGED that fresh descendant into this root, so we don't see it
      // as its own change here. Left null → humanizes without the "(a …)" clause.
      // DRAFT — to fill friendlyType we'd need the pipeline to pass the merged-descendant
      // types; deferred (coverage, not voice). role likewise defaults to "variable".
      return {
        kind: "StateAdded",
        name: name(ctx, root.entity.uuid, meta.seq),
        friendlyType: null,
        role: "variable",
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // A fresh TYPE entity whose parent is a non-fresh State/ArgSlot = a RETYPE
    // (the `@syncing.child type` was swapped). The new type is the fresh entity itself.
    // (A type born under a FRESH State is that State's birth payload → already merged.)
    if (isTypeEntity(t)) {
      const ownerName = owner(ctx, root.entity.uuid, meta.seq);
      return {
        kind: "TypeChanged",
        owner: ownerName,
        friendlyTo: friendlyType(t),
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // A fresh arg-shape node under a non-fresh callable = SlotAdded (hardening §1.7:
    // fresh child of a non-fresh parent). Under a FRESH callable it's birth payload → merged.
    if (ARG_SHAPE_NODES.has(t)) {
      return {
        kind: "SlotAdded",
        shape: t === "ArgRecord" ? "record" : t === "ArgTuple" ? "tuple" : t === "ArgSwitch" ? "switch" : "arg",
        name: name(ctx, root.entity.uuid, meta.seq),
        owner: owner(ctx, root.entity.uuid, meta.seq),
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // A fresh SlotParam under a non-fresh Component = a render/content slot added.
    // (A SlotParam born with a fresh Component is component-birth payload → merged.)
    if (t === "SlotParam") {
      return {
        kind: "SlotAdded",
        shape: "arg",
        name: name(ctx, root.entity.uuid, meta.seq),
        owner: owner(ctx, root.entity.uuid, meta.seq),
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // A fresh ExposedSpec under a non-fresh State = the State just became a prop.
    if (t === "ExposedSpec") {
      return {
        kind: "StateExposureToggled",
        name: owner(ctx, root.entity.uuid, meta.seq),
        exposed: true,
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // A fresh EventEmitterDecl under a non-fresh ReturnSlot = an emitter was declared.
    if (t === "EventEmitterDecl") {
      return {
        kind: "EmitterChanged",
        what: "declared",
        detail: "an event emitter", // DRAFT — style (node/browser) rides in a child `style` set we don't see at birth
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    // A fresh ProviderSource under a non-fresh UnionType = a feature-flag binding.
    if (t === "ProviderSource") {
      return {
        kind: "FeatureFlagBindingChanged",
        op: "bound",
        provider: str(undefined), // DRAFT — provider rides in a child `provider` set, merged at birth; resolve later
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }

    return null;
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): ParamsStatesTypesIntent | null {
    const t = c.entity.type;
    const u = c.entity.uuid;
    const base = { sourceUuids: meta.sourceUuids, seq: meta.seq, timestamp: meta.timestamp, author: meta.author };

    // ── State edits ─────────────────────────────────────────────────────────
    if (t === "State") {
      if (c.verb === "set" && c.field === "name" && c.before !== undefined) {
        return { kind: "StateRenamed", from: str(c.before), to: str(c.after), ...base };
      }
      // `represents` flips to/from "derivation" (the only known value).
      if (c.verb === "set" && c.field === "represents") {
        return { kind: "StateDerivationMarked", name: name(ctx, u, meta.seq), isDerivation: c.after === "derivation", ...base };
      }
      // `exposed` child cleared (set to null) = the State went internal. (Becoming a prop
      // is the ExposedSpec BIRTH, handled in recognizeBirth.)
      if (c.verb === "clear" && c.field === "exposed") {
        return { kind: "StateExposureToggled", name: name(ctx, u, meta.seq), exposed: false, ...base };
      }
    }

    // ── State / SlotParam removal (detach) ────────────────────────────────────
    // State and arg-/return-shape detaches all share one cascade; route by entity type.
    if (c.verb === "detach") {
      if (t === "State") return { kind: "StateRemoved", name: name(ctx, u, meta.seq), ...base };
      if (ARG_SHAPE_NODES.has(t) || t === "SlotParam") {
        return { kind: "SlotRemoved", name: name(ctx, u, meta.seq), owner: owner(ctx, u, meta.seq), ...base };
      }
    }

    // ── ExposedSpec.onChange (two-way binding) ────────────────────────────────
    if (t === "ExposedSpec" && c.field === "onChange") {
      // owner of an ExposedSpec is the State (ExposedSpec extends PlexusModel<State>).
      const bound = c.verb === "set" && c.after != null;
      return { kind: "StateTwoWayBindingChanged", state: owner(ctx, u, meta.seq), bound, ...base };
    }

    // ── ArgSlot scalar edits ──────────────────────────────────────────────────
    if (t === "ArgSlot") {
      if (c.field === "required" && c.before !== undefined) {
        return { kind: "SlotRequiredToggled", name: name(ctx, u, meta.seq), required: c.after === true, ...base };
      }
      if (c.field === "priority" && c.before !== undefined) {
        return { kind: "SlotPriorityChanged", name: name(ctx, u, meta.seq), ...base };
      }
      if (c.field === "role") {
        return { kind: "SlotRoleChanged", name: name(ctx, u, meta.seq), asSignal: c.after === "callbackAsSignal", ...base };
      }
      if (c.field === "displayName" && c.after != null) {
        return { kind: "SlotBindingChanged", to: str(c.after), ...base };
      }
    }

    // ── ReturnSlot / SlotParam displayName (the slot label / wire name) ────────
    if ((t === "ReturnSlot" || t === "SlotParam") && c.field === "displayName" && c.after != null) {
      return { kind: "SlotBindingChanged", to: str(c.after), ...base };
    }

    // ── ChoiceType options (ChoiceOption insert/remove, or a string-list entry) ─
    // ChoiceType registers as "Choice"; its `options` is a child.list (ChoiceOption[])
    // OR a string[]. A ChoiceOption ENTITY add lands as a materialize → recognizeBirth
    // (fresh child of non-fresh Choice) — handled there? No: ChoiceOption is not in our
    // birth set. We catch the string-list case here (insert/remove on Choice.options),
    // and the ChoiceOption-entity case below in the materialize fallthrough is left to
    // its own birth handling. For the string-list:
    if (t === "Choice" && c.field === "options" && (c.verb === "insert" || c.verb === "remove")) {
      return {
        kind: "ChoiceOptionsChanged",
        owner: owner(ctx, u, meta.seq),
        op: c.verb === "insert" ? "added" : "removed",
        label: str(c.verb === "insert" ? c.after : c.before),
        ...base,
      };
    }

    // ── ArgSwitch arms (ArgMatch entities) ────────────────────────────────────
    // An ArgMatch is born/detached under an ArgSwitch. Birth of a fresh ArgMatch under a
    // non-fresh ArgSwitch reaches recognizeBirth as a non-owned type → null → here we only
    // see the detach (remove). A genuine arm-add is the ArgMatch materialize; we surface
    // arm-removal via detach, arm-addition is left to RawEdit unless the value rides a set.
    if (t === "ArgMatch" && c.verb === "detach") {
      // value is on the ArgMatch itself (a prior `set value`), not recoverable from detach;
      // render generically.
      return { kind: "ArgSwitchArmsChanged", op: "removed", arm: armPhrase(undefined), ...base };
    }

    // ── ReturnRecord shape: fields (entity record) + stateWiring (primitive record) ──
    if (t === "ReturnRecord") {
      // `stateWiring` is a @syncing.record (primitive) — paired set/clear with `key`.
      if (c.field === "stateWiring") {
        return {
          kind: "ReturnShapeChanged",
          what: "wiring",
          op: c.verb === "clear" ? "removed" : "added",
          field: c.key ?? "?",
          ...base,
        };
      }
      // `fields` is @syncing.child.record — entries materialize as ReturnSlot/ReturnRecord
      // ENTITIES (handled at birth, not here). A reorder/remove of the record entry surfaces
      // as detach on the child (caught above for shape nodes). Nothing extra here.
    }

    // ── ClassNamePropType selectors (LabeledSelector list) ────────────────────
    // LabeledSelector born under a non-fresh ClassNamePropType reaches recognizeBirth as a
    // non-owned type → null. Its label edit and selector text live on the entity:
    if (t === "LabeledSelector") {
      if (c.field === "selector" && c.before !== undefined) {
        return { kind: "ClassNameSelectorsChanged", op: "relabelled", selector: str(c.after), ...base };
      }
      if (c.field === "label" && c.after != null) {
        return { kind: "ClassNameSelectorsChanged", op: "relabelled", selector: str(c.after), ...base };
      }
    }
    if (t === "LabeledSelector" && c.verb === "detach") {
      return { kind: "ClassNameSelectorsChanged", op: "removed", selector: name(ctx, u, meta.seq), ...base };
    }

    // ── ColorPropType.noDeref / RefType.callbackRef flips ─────────────────────
    if (t === "ColorPropType" && c.field === "noDeref" && c.before !== undefined) {
      return { kind: "TypeFlagToggled", flag: "color-deref", on: c.after === true, ...base };
    }
    if (t === "RefType" && c.field === "callbackRef" && c.before !== undefined) {
      return { kind: "TypeFlagToggled", flag: "ref-kind", on: c.after === true, ...base };
    }

    // ── ProviderSource edits (feature-flag binding) ───────────────────────────
    if (t === "ProviderSource") {
      if (c.verb === "detach") return { kind: "FeatureFlagBindingChanged", op: "unbound", provider: "?", ...base };
      if (c.field === "provider" && c.before !== undefined) {
        return { kind: "FeatureFlagBindingChanged", op: "remapped", provider: str(c.after), ...base };
      }
      // externalKeys is a @syncing.record (primitive, key-carried) — a key-remap; left to
      // RawEdit (the inner provider-key mapping is plumbing, low salience). DRAFT — V review.
    }

    // ── EmitterEvent (event name / payload) ───────────────────────────────────
    if (t === "EmitterEvent" && c.field === "name" && c.after != null) {
      return { kind: "EmitterChanged", what: "event", detail: str(c.after), ...base };
    }

    // ── arg-shape list reorders (ArgTuple.items / ArgRecord.fields / FormType.schema) ─
    if (c.verb === "reorder" && (t === "ArgTuple" || t === "ArgRecord" || t === "FormType")) {
      return { kind: "SlotReordered", owner: owner(ctx, u, meta.seq), ...base };
    }

    // ── CrossFieldRule (form rules) ───────────────────────────────────────────
    if (t === "CrossFieldRule") {
      if (c.verb === "detach") return { kind: "FormRuleChanged", op: "removed", ...base };
      // a rule/message child edit reads as "edited" (the rule body is an expr, low-detail).
      if (c.verb === "set" || c.verb === "clear") return { kind: "FormRuleChanged", op: "edited", ...base };
    }

    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "StateAdded": {
        const ty = e.friendlyType ? ` (a ${e.friendlyType})` : "";
        const noun = e.role === "prop" ? "prop" : e.role === "derivation" ? "derivation" : "variable";
        return `Added ${noun} "${e.name}"${ty}`; // DRAFT — V review
      }
      case "StateRemoved":
        return `Removed "${e.name}"`; // DRAFT — V review
      case "StateRenamed":
        return `Renamed "${e.from}" → "${e.to}"`; // DRAFT — V review
      case "StateExposureToggled":
        return e.exposed ? `"${e.name}" is now a public prop` : `"${e.name}" is now an internal variable`; // DRAFT — V review
      case "StateDerivationMarked":
        return e.isDerivation ? `"${e.name}" is now a derivation` : `"${e.name}" is now an ordinary variable`; // DRAFT — V review
      case "TypeChanged":
        return `Retyped "${e.owner}" → ${e.friendlyTo}`; // DRAFT — V review
      case "StateTwoWayBindingChanged":
        return e.bound ? `"${e.state}" is now two-way bound to its host` : `"${e.state}" is no longer two-way bound`; // DRAFT — V review
      case "ChoiceOptionsChanged":
        return e.op === "added" ? `"${e.owner}" options: added "${e.label}"` : `"${e.owner}" options: removed "${e.label}"`; // DRAFT — V review
      case "SlotAdded": {
        const what = e.shape === "record" ? "a group of args" : e.shape === "tuple" ? "a tuple of args" : e.shape === "switch" ? "a switch" : "arg";
        return `Added ${what} "${e.name}" to ${e.owner}`; // DRAFT — V review
      }
      case "SlotRemoved":
        return `Removed "${e.name}" from ${e.owner}`; // DRAFT — V review
      case "SlotReordered":
        return `Reordered args in ${e.owner}`; // DRAFT — V review
      case "SlotRequiredToggled":
        return e.required ? `"${e.name}" is now required` : `"${e.name}" is now optional`; // DRAFT — V review
      case "SlotPriorityChanged":
        return `Adjusted display order of "${e.name}"`; // DRAFT — V review
      case "SlotRoleChanged":
        return e.asSignal ? `the "${e.name}" callback is now a signal source` : `the "${e.name}" callback is now an ordinary callback`; // DRAFT — V review
      case "SlotBindingChanged":
        return `Labeled a slot "${e.to}"`; // DRAFT — V review
      case "ArgSwitchArmsChanged":
        return e.op === "added" ? `Added a switch arm ${e.arm}` : `Removed a switch arm`; // DRAFT — V review
      case "ReturnShapeChanged":
        if (e.what === "wiring") return `Paired a read↔write half ("${e.field}")`; // DRAFT — V review
        return e.op === "added" ? `output: added "${e.field}"` : `output: removed "${e.field}"`; // DRAFT — V review
      case "EmitterChanged":
        return e.what === "declared" ? `Declared ${e.detail}` : `emitter exposes event "${e.detail}"`; // DRAFT — V review
      case "TypeFlagToggled":
        if (e.flag === "color-deref") return e.on ? `color: kept raw (no token deref)` : `color: resolved through tokens`; // DRAFT — V review
        return e.on ? `the ref is now a callback ref` : `the ref is now a ref object`; // DRAFT — V review
      case "ClassNameSelectorsChanged":
        if (e.op === "added") return `selectors: added "${e.selector}"`; // DRAFT — V review
        if (e.op === "removed") return `selectors: removed "${e.selector}"`; // DRAFT — V review
        return `selector relabelled "${e.selector}"`; // DRAFT — V review
      case "FeatureFlagBindingChanged":
        if (e.op === "bound") return `Bound to a feature-flag source`; // DRAFT — V review (provider resolved later)
        if (e.op === "unbound") return `Unbound the feature-flag source`; // DRAFT — V review
        return `Remapped the "${e.provider}" flag binding`; // DRAFT — V review
      case "FormRuleChanged":
        if (e.op === "added") return `Added a cross-field form rule`; // DRAFT — V review
        if (e.op === "removed") return `Removed a cross-field form rule`; // DRAFT — V review
        return `Edited a cross-field form rule`; // DRAFT — V review
      default:
        return null;
    }
  },
};

/** A switch arm's literal, domain-aware (design §3 / hardening §2.2: null/boolean → phrase). */
function armPhrase(v: unknown): string {
  if (v === undefined) return ""; // unrecoverable (detach) → bare
  if (v === null) return "for the empty/null case";
  if (typeof v === "boolean") return `"${v}" (boolean case)`;
  return `"${str(v)}"`;
}
