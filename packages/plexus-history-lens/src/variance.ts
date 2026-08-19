import { type ComboKey, type EntityRef, parentChain, resolveRef } from "@here.build/plexus-history";
import type * as Y from "yjs";

/**
 * Typed variance — the realization of "variance is an intent AXIS, not a path" (lens-architecture.md
 * §3). A variant combo isn't styling-path; it's a coordinate whose PHRASING is dictated by the
 * variant's `VariantGroup.subject` type. The kind drives both the natural-language clause (pass2's
 * `coordinateClause`) and the grouping (same coordinate ⇒ one gesture).
 */
/**
 * The object FACETS whose child-map is keyed by a variant combo (`Map<Set<Variant>, …>`) — so their
 * coordinate slot is a `serializeKey` combo to feed `parseComboKey` + {@link resolveVarianceCoord}.
 * Other keyed facets (a CSS property inside a RuleSet, a record entry, a `Map<State,…>`) carry a plain
 * or non-Set key and MUST NOT be routed through the combo parser. Verified `@syncing.child.map
 * Map<Set<Variant>,…>` on AbstractTplNode (rs/attrs/eventHandlers, TplNode.ts) + ComponentBase.frames.
 * Token `values` and the text aspect join here once confirmed against the model.
 */
export const VARIANCE_KEYED_FACETS: ReadonlySet<string> = new Set(["rs", "attrs", "eventHandlers", "frames"]);

export type VarianceKind = "pseudo-state" | "environment" | "component-state" | "condition";

/** A resolved coordinate: the kind + the variant display names (never uuids). */
export interface VarianceCoord {
  kind: VarianceKind;
  variants: string[];
}

/**
 * `VariantGroup.subject`'s `@syncing("…")` nodeName → the variance kind. Cited to the model source
 * (here.build/public-packages/model/src/models/variance/*, exprs/CustomCode.ts, state/State.ts):
 *   - State            → component-state  ("in the danger state")
 *   - ElementEnvironment → pseudo-state    (standalone element pseudo — :hover/:focus; "when hovered")
 *   - MediaEnvironment / RouterEnvironment / Environment → environment ("in dark mode" / breakpoint / route)
 *   - CustomCode       → condition         (arbitrary boolean predicate; "when <name>")
 * Unknown / null subject → condition (the safe generic — a predicate we can't type more precisely).
 */
export function varianceKindOf(subjectType: string | null | undefined): VarianceKind {
  switch (subjectType) {
    case "State":
      return "component-state";
    case "ElementEnvironment":
      return "pseudo-state";
    case "MediaEnvironment":
    case "RouterEnvironment":
    case "Environment":
      return "environment";
    case "CustomCode":
      return "condition";
    default:
      return "condition";
  }
}

/**
 * A variant's KIND source: walk `variant → its VariantGroup (the variant's owner) → the group's
 * `subject` REF → the subject's type`. `null` if the variant isn't a grouped variant or the subject
 * doesn't resolve. (The walk itself — parentChain[1] + resolveRef('subject') — is proven against real
 * Plexus storage in core's combo-key.test.ts.)
 */
export function variantSubjectType(archive: Y.Doc, variantUuid: string): string | null {
  const chain = parentChain(archive, variantUuid);
  const group = chain[1]?.ref; // a variant's owner is its VariantGroup
  if (!group || group.type !== "VariantGroup") return null;
  return resolveRef(archive, group.uuid, "subject")?.type ?? null;
}

/**
 * A parsed combo (from `parseComboKey`) → a typed {@link VarianceCoord}. PURE over `(combo, nameOf,
 * subjectTypeOf)` — `nameOf` resolves each variant's display name (the product's job), `subjectTypeOf`
 * its subject type (the live impl is {@link variantSubjectType}; inject a synthetic one in tests).
 *
 * Returns `null` for a non-Set combo or the empty (base) combo — no variance clause. Multi-axis combos
 * (variants from different groups) take the FIRST variant's kind for now; mixed-kind phrasing is the
 * open edge (lens-architecture.md §"not whole").
 */
export function resolveVarianceCoord(
  combo: ComboKey,
  nameOf: (uuid: string) => string | undefined,
  subjectTypeOf: (uuid: string) => string | null,
): VarianceCoord | null {
  if (combo.kind !== "set") return null;
  const refs: EntityRef[] = combo.members.flatMap((m) => ("ref" in m ? [m.ref] : []));
  if (refs.length === 0) return null;
  const variants = refs.map((r) => nameOf(r.uuid) ?? r.uuid);
  const kind = varianceKindOf(subjectTypeOf(refs[0].uuid));
  return { kind, variants };
}
