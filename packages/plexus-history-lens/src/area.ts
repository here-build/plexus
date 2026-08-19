import type { PlexusChange, UserSession } from "@here.build/plexus-history";

import type { IntentEvent } from "./types.js";

/**
 * The lens's window into the here.build model (clay tenet: core stays domain-agnostic; the PRODUCT
 * resolves names). `nameOf` reads an entity's display name at a cut; `ownerOf` walks to an owning
 * component (e.g. a PageMeta's PageComponent) for owner-scoped intents like the page route.
 */
export interface LensCtx {
  nameOf: (uuid: string, atSeq: number) => string | undefined;
  ownerOf?: (uuid: string, atSeq: number) => string | undefined;
}

/** Per-cut envelope a recognizer stamps onto its event (the {@link IntentEventBase} fields). */
export interface CutMeta {
  seq: number;
  timestamp: number;
  author: UserSession | null;
  /** The audit trail back to this cut's PlexusChange[] — every recognizer stamps the whole cut. */
  sourceUuids: string[];
}

/**
 * An `AreaModule` is one moldable piece of clay: a here.build model AREA (Component, Page, Token,
 * Variant, …) packaged as a pluggable recognizer + renderer. The CENTRAL pipeline ({@link consolidate})
 * owns the cut-level structure (groupBy seq · FRESH-by-cut · birth-root detection · the fresh-descendant
 * + fresh-child-insert absorption); each area only answers "do I own THIS change, and if so what intent?".
 *
 * Three hooks, all OPTIONAL except `humanize` is mandatory:
 *
 * - `recognizeBirth` — the pipeline found a birth ROOT (a `materialized` whose parent isn't fresh this
 *   cut) and is offering it to the areas. An area returns an `*Added` intent iff it OWNS `root.entity.type`,
 *   else `null` (the pipeline tries the next area; unclaimed births are absorbed/dropped per the MVP).
 * - `recognizeEdit` — a non-fresh, non-absorbed change. An area returns its `*Changed`/`*Renamed`/
 *   `*Removed` intent iff it owns the change, else `null` (→ next area → RawEdit degrade).
 * - `humanize` — render this area's own kinds to a line; `null` if `event.kind` isn't one of this area's.
 * - `fragment` — render this area's FACET-kinds to a groupable phrase (Pass 2); `null` otherwise.
 */
export interface AreaModule {
  /** Stable area id (Component, Page, …) — for debugging / registry ordering, not behavior. */
  name: string;

  /**
   * A birth ROOT this area might own. `fresh` is the cut's FRESH set (materialized uuids) so an area can
   * fold a co-fresh sibling if it owns the cluster. Return an `*Added` `IntentEvent`, or `null` to defer.
   */
  recognizeBirth?(root: PlexusChange, ctx: LensCtx, meta: CutMeta, fresh: Set<string>): IntentEvent | null;

  /** A non-fresh, non-absorbed change. Return this area's edit intent, or `null` to defer. */
  recognizeEdit?(change: PlexusChange, ctx: LensCtx, meta: CutMeta): IntentEvent | null;

  /** Render this area's kinds. Return `null` if `event.kind` is not one of this area's. */
  humanize(event: IntentEvent): string | null;

  /**
   * The Pass-2 dual of {@link humanize} (lens-architecture.md §4 + §6). For a FACET event — a change to a
   * facet of an OBJECT (an element's styling / behavior / attrs / text), the "X gets … under coord" frame —
   * return JUST the facet phrase ("a click handler", "pointer cursor", "background"): NO object prefix and
   * NO coordinate clause (the composer adds the object and `coordinateClause` when it groups by
   * `(object, coordinate)`). Return `null` for a SUBJECT/lifecycle event (component added, variant renamed,
   * route changed) — those are standalone subject-events (§5 define-vs-use) that pass through `humanize`
   * unchanged, never folding into a coordinate gesture. Optional: areas adopt it as their facets are wired.
   */
  fragment?(event: IntentEvent): string | null;
}
