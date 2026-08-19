import { parentChain, parseComboKey, type PlexusChange } from "@here.build/plexus-history";
import type * as Y from "yjs";

import type { LensCtx } from "./area.js";
import { resolveTarget } from "./resolve-target.js";
import { resolveVarianceCoord, VARIANCE_KEYED_FACETS, type VarianceCoord, variantSubjectType } from "./variance.js";

/**
 * A change fully resolved to its named OBJECT, FACET, and typed COORDINATE — the object-centric reading
 * of a raw `PlexusChange` (lens-architecture.md §1-3). This is the public entry point that composes the
 * spine: `parentChain` (core) → `resolveTarget` (locate) → `parseComboKey` + `resolveVarianceCoord`
 * (type the coordinate). The FRAGMENT (the human property+value, e.g. "red background") is built
 * per-area downstream — this is the structural + coordinate resolution it hangs on.
 */
export interface ChangeResolution {
  object: { uuid: string; type: string; name: string };
  facet: string | null;
  /** Typed variance coordinate; absent for the base combo or a non-variance facet. */
  coordinate?: VarianceCoord;
  change: PlexusChange;
}

/**
 * Resolve a change to its `(named object, facet, typed coordinate)` against the archive + the product's
 * `ctx.nameOf`. Returns `null` when no named object owns the change (caller degrades to a raw edit).
 */
export function resolveChange(change: PlexusChange, archive: Y.Doc, ctx: LensCtx): ChangeResolution | null {
  const target = resolveTarget(change, parentChain(archive, change.entity.uuid));
  if (!target) return null;

  const object = {
    uuid: target.object.uuid,
    type: target.object.type,
    name: ctx.nameOf(target.object.uuid, change.seq) ?? target.object.type,
  };

  // The coordinate is a variant combo ONLY for variance-keyed facets (rs/attrs/eventHandlers/frames);
  // other keyed slots (a CSS property, a record entry) carry a plain key — never route those to the
  // combo parser. resolveVarianceCoord further returns null for non-Set / base combos.
  let coordinate: VarianceCoord | undefined;
  if (target.coordinateMeta && target.facet && VARIANCE_KEYED_FACETS.has(target.facet)) {
    const combo = parseComboKey(target.coordinateMeta, archive);
    coordinate =
      resolveVarianceCoord(
        combo,
        (u) => ctx.nameOf(u, change.seq),
        (u) => variantSubjectType(archive, u),
      ) ?? undefined;
  }

  return { object, facet: target.facet, coordinate, change };
}
