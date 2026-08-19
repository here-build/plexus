import type { ChainHop, EntityRef, PlexusChange } from "@here.build/plexus-history";

import { isHerebuildObject } from "./object-types.js";

/**
 * The (object · facet · coordinate-location) triple for a change — the structural half of the
 * object-centric lens (lens-architecture.md §1–2). PURE over `(change, chain)`: `parentChain` (core)
 * supplies the `\0`-walk; this locates the **object** (the first object-type up the chain), the
 * **facet** (the object's field that owns the changed branch), and the raw **coordinate** slot.
 *
 * Locating ≠ resolving: `coordinateMeta` is the raw serialized key. Parse it with `parseComboKey`
 * (+ the archive, + `ctx.nameOf`) ONLY for variance-keyed facets (rs / attrs / eventHandlers / a
 * token's combo `values`); plain-string keys (a CSS property, a record entry) are not combos. That
 * facet→is-variance-keyed decision is the area's, downstream — kept out of this pure structural step.
 */
export interface ResolvedTarget {
  /** The named subject the change collapses up to. */
  object: EntityRef;
  /**
   * The object's field that owns the changed branch (`"rs"`→styling, `"eventHandlers"`→behavior, …),
   * or the change's own field when the change is directly on the object. `null` when neither applies.
   */
  facet: string | null;
  /**
   * The coordinate's raw keyed-slot string at the object boundary — a `serializeKey` combo for a
   * variance-keyed facet (feed {@link import("@here.build/plexus-history").parseComboKey}), or a plain
   * entry key, or `null` (base combo / scalar field).
   */
  coordinateMeta: string | null;
  /** The originating change (the fragment — property + value — is built from this downstream). */
  change: PlexusChange;
}

/**
 * Resolve a change to its `(object, facet, coordinate)`. `chain` = `parentChain(archive, change.entity.uuid)`
 * (hop[0] is the change's own entity). Returns `null` when no named object owns the change (an orphan or
 * an unmodeled type) — the caller degrades to a raw edit.
 *
 * `isObject` is injected (defaults to the here.build object-set) so the walk logic is independent of the
 * exact roster — and so a test can drive the boundary with a synthetic predicate.
 */
export function resolveTarget(
  change: PlexusChange,
  chain: ChainHop[],
  isObject: (type: string) => boolean = isHerebuildObject,
): ResolvedTarget | null {
  const k = chain.findIndex((hop) => isObject(hop.ref.type));
  if (k === -1) return null;
  const object = chain[k].ref;

  // k === 0: the change is directly ON the object (rename a component; set a token field; set a
  // child-map entry whose KEY is the combo). Facet = the changed field; coordinate = the change's own
  // keyed slot if any (a child-map set carries the combo in `change.key`).
  if (k === 0) {
    return { object, facet: change.field ?? null, coordinateMeta: change.key ?? null, change };
  }

  // k > 0: the change is on an application-path descendant. The branch entered the object via the hop
  // just below it (`chain[k-1]`): its `field` is the object's owning field (→ facet) and its `comboMeta`
  // is the coordinate. (here.build keys its variance maps — rs/attrs/eventHandlers — directly on the
  // ELEMENT/token, so the combo always sits at this object↔child boundary; deeper hops are sub-detail.)
  const boundary = chain[k - 1];
  return { object, facet: boundary.field, coordinateMeta: boundary.comboMeta, change };
}
