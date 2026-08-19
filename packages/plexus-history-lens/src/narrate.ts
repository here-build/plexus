import type { PlexusChange } from "@here.build/plexus-history";
import type * as Y from "yjs";

import { consolidate, type LensCtx } from "./consolidate.js";
import { humanizeOne } from "./humanize.js";
import { objectKind } from "./object-types.js";
import { composeGesture, coordKey, type ObjectRef } from "./pass2.js";
import { AREAS } from "./registry.js";
import type { IntentEvent } from "./types.js";
import type { VarianceCoord } from "./variance.js";

/**
 * The middle-end's OUTPUT composer — `IntentEvent[] → human lines`, running BOTH consolidation passes
 * (lens-architecture.md §4). The events come from {@link consolidate} *with the archive* so each carries its
 * object-centric resolution (`object` + typed `coordinate`); this routes them:
 *
 *   - a FACET event (an area gave it a {@link import("./area.js").AreaModule.fragment}, and it has an
 *     `object`) folds into its `(object, coordinate)` gesture — Pass 2: *"action button gets a click handler,
 *     cursor, and scale when hovered"* (§4 flagship).
 *   - a SUBJECT / lifecycle event (component added, variant renamed, route set — §5 define-vs-use) is a
 *     standalone line via {@link humanizeOne}, never folded into a coordinate.
 *
 * Order is FIRST-APPEARANCE: a subject line sits where it occurs; a gesture sits where its FIRST facet
 * occurred, accreting later facets of the same `(object, coordinate)` into that one slot. So a real diff reads
 * as an ordered mix of subject lines and grouped gestures — never reshuffled.
 */
export function narrate(events: IntentEvent[]): string[] {
  type Group = { kind: "group"; object: ObjectRef; coordinate?: VarianceCoord; fragments: string[] };
  type Slot = { kind: "line"; text: string } | Group;

  const slots: Slot[] = [];
  const groupAt = new Map<string, Group>(); // (object, coordinate) key → its slot (first-appearance anchored)

  for (const e of events) {
    const fragment = fragmentOf(e);
    // A facet event needs BOTH a fragment (an area owns its facet rendering) AND a resolved object (the
    // subject it folds into). Missing either ⇒ treat as a standalone subject line.
    if (fragment !== null && e.object) {
      const object: ObjectRef = { kind: objectKind(e.object.type), name: e.object.name };
      const key = `${object.kind} ${object.name} ${coordKey(e.coordinate)}`;
      const existing = groupAt.get(key);
      if (existing) {
        existing.fragments.push(fragment);
      } else {
        const group: Group = { kind: "group", object, coordinate: e.coordinate, fragments: [fragment] };
        groupAt.set(key, group);
        slots.push(group);
      }
    } else {
      slots.push({ kind: "line", text: humanizeOne(e) });
    }
  }

  return slots.map((s) => (s.kind === "line" ? s.text : composeGesture(s.object, s.fragments, s.coordinate)));
}

/** The Pass-2 facet phrase for an event, dispatched over the area registry (first non-null), else `null` (a subject event). */
function fragmentOf(e: IntentEvent): string | null {
  for (const area of AREAS) {
    const f = area.fragment?.(e);
    if (f != null) return f;
  }
  return null;
}

/**
 * End-to-end convenience: `PlexusChange[] → human lines`, both passes. Equivalent to
 * `narrate(consolidate(changes, ctx, archive))` — the archive is REQUIRED here (it's what stamps the
 * object/coordinate resolution Pass 2 groups on). For the flat per-event annotation (no grouping), use
 * `humanize(consolidate(changes, ctx))` instead.
 */
export function narrateChanges(changes: PlexusChange[], ctx: LensCtx, archive: Y.Doc): string[] {
  return narrate(consolidate(changes, ctx, archive));
}
