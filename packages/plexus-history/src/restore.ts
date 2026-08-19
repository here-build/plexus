import type * as Y from "yjs";

import { PARENT_ATTR, xmlElByUuid } from "./internal.js";
import { currentValue, valueAsOf } from "./point-in-time.js";
import type { Cut, PlexusChange } from "./types.js";

/**
 * A target to restore: an entity, which fields to consider, and whether to also restore its
 * ownership pointer (`\0` → reparent/detach). Subtree enumeration stays the caller's job (the
 * product walks its own children) — pass each member of the subtree as a target.
 */
export interface RestoreTarget {
  uuid: string;
  type: string;
  fields?: string[];
  /** Also restore the `\0` ownership pointer (emit `reparent`/`detach` if it changed). */
  parent?: boolean;
}

/**
 * Compute the forward changes that would restore `targets` to their state at `toCut`.
 * Restore is forward-append (entities-forever ⇒ re-set / re-adopt, never resurrect), and this
 * is the PLAN — preview it, then a server-side `applyRestore` writes it via Plexus mutation
 * (the "hands" live in @here.build/plexus, gated server-side — still unimplemented here).
 *
 * Covers per-target: scalar field set/clear, and `\0` reparent/detach (via `parent: true`).
 * TODO: collection-element (Y.Array splice) restore; subtree auto-enumeration (caller-supplied
 * for now); and `applyRestore` itself.
 */
export function planRestore(archive: Y.Doc, targets: RestoreTarget[], toCut: Cut, cutsUpTo: Cut[]): PlexusChange[] {
  const plan: PlexusChange[] = [];
  const push = (p: Omit<PlexusChange, "seq" | "timestamp" | "author">): void => {
    plan.push({ seq: -1, timestamp: Number.NaN, author: null, ...p }); // seq/timestamp/author stamped on apply
  };

  for (const t of targets) {
    const entity = { uuid: t.uuid, type: t.type };

    for (const field of t.fields ?? []) {
      const want = valueAsOf(archive, t.uuid, field, toCut, cutsUpTo);
      const have = currentValue(archive, t.uuid, field);
      if (JSON.stringify(want) === JSON.stringify(have)) continue;
      if (want === undefined) push({ verb: "clear", entity, field, before: have });
      else push({ verb: "set", entity, field, before: have, after: want });
    }

    if (t.parent) {
      const want = valueAsOf(archive, t.uuid, PARENT_ATTR, toCut, cutsUpTo) as unknown[] | undefined;
      const have = currentValue(archive, t.uuid, PARENT_ATTR) as unknown[] | undefined;
      if (JSON.stringify(want) !== JSON.stringify(have)) {
        const toUuid = want?.[0] as string | undefined;
        const fromUuid = have?.[0] as string | undefined;
        const from = fromUuid !== undefined ? { from: { uuid: fromUuid, type: "unknown" } } : {};
        if (toUuid !== undefined) push({ verb: "reparent", entity, ...from, to: { uuid: toUuid, type: "unknown" } });
        else push({ verb: "detach", entity, ...from });
      }
    }
  }

  return plan;
}

/**
 * Apply a {@link planRestore} plan to a live doc as forward Yjs mutations, in ONE transaction
 * (re-set / re-adopt — entities-forever ⇒ never resurrect). The "hands" of restore; server-gated.
 *
 * Covers `set` / `clear` / `detach` fully. `reparent` is best-effort: the plan carries the new
 * parent uuid but not the `\0` tuple's field-key/meta, so those are preserved from the entity's
 * current `\0` (correct for a same-field parent swap; a cross-field reparent would need the full
 * tuple carried in the plan — TODO).
 */
export function applyRestore(doc: Y.Doc, plan: PlexusChange[]): void {
  doc.transact(() => {
    for (const ch of plan) {
      const el = xmlElByUuid(doc, ch.entity.uuid);
      if (!el) continue;
      // Inline member-call preserves `this === el` (a bare `const f = el.setAttribute` would detach it).
      const setAttr = (k: string, v: unknown): void => (el.setAttribute as (k: string, v: unknown) => void)(k, v);
      switch (ch.verb) {
        case "set":
          if (ch.field !== undefined) setAttr(ch.field, ch.after);
          break;
        case "clear":
          if (ch.field !== undefined) el.removeAttribute(ch.field);
          break;
        case "detach":
          el.removeAttribute(PARENT_ATTR);
          break;
        case "reparent": {
          if (!ch.to) break;
          // The plan carries the new parent uuid only; preserve field-key/meta from the current `\0`.
          const cur = currentValue(doc, ch.entity.uuid, PARENT_ATTR) as unknown[] | undefined;
          const fieldKey = (cur?.[1] as string | undefined) ?? "children";
          const meta = cur?.[2];
          setAttr(PARENT_ATTR, meta != null ? [ch.to.uuid, fieldKey, meta] : [ch.to.uuid, fieldKey]);
          break;
        }
      }
    }
  });
}
