import type * as Y from "yjs";

import { PARENT_ATTR, refByUuid, xmlElByUuid } from "./internal.js";
import { valueAsOf } from "./point-in-time.js";
import type { Cut, EntityRef } from "./types.js";

/**
 * One ownership step: an entity AND how its parent holds it. The `field`/`comboMeta` describe the
 * entity's `\0` pointer INTO its parent (not the entity itself), so a consumer can recover both the
 * containing field (→ facet) and the keyed slot (→ coordinate) without a reverse scan of the parent.
 *
 * - `field` — `\0` tuple[1]: the parent field that owns this entity (`"rs"`, `"eventHandlers"`, a
 *   child-list key, …). `null` at the root (no parent pointer).
 * - `comboMeta` — `\0` tuple[2]: the SERIALIZED map/set/record key under which the parent holds this
 *   entity (Plexus `serializeKey` form — feed to {@link import("./combo-key.js").parseComboKey}).
 *   `null` for child-val / positional child-list members (no key) and at the root.
 */
export interface ChainHop {
  ref: EntityRef;
  field: string | null;
  comboMeta: string | null;
}

/**
 * The ownership chain `[entity, parent, …, root]` for `uuid`, each hop carrying its `\0` pointer
 * (field + serialized key). This is the `\0`-walk every consumer was re-implementing by hand, now
 * carrying the full tuple so the resolver can read facet (field) + coordinate (comboMeta) in one pass.
 *
 * Default: the archive's CURRENT tree (`\0` read live). With `asOfCut` (+ `cutsUpTo` =
 * `cutLog.range(0, asOfCut.seq)`): the tree AS IT WAS at that cut — each `\0` resolved via
 * {@link valueAsOf}, so reparents are respected (a file shows its *then*-parent, not its now-parent).
 */
export function parentChain(archive: Y.Doc, uuid: string, asOfCut?: Cut, cutsUpTo?: Cut[]): ChainHop[] {
  const chain: ChainHop[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = uuid;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const el = xmlElByUuid(archive, cur);
    if (!el) break;
    const tuple = (
      asOfCut
        ? valueAsOf(archive, cur, PARENT_ATTR, asOfCut, cutsUpTo ?? [])
        : el.getAttribute(PARENT_ATTR)
    ) as unknown[] | undefined;
    chain.push({
      ref: { uuid: cur, type: el.nodeName },
      field: (tuple?.[1] as string | undefined) ?? null,
      comboMeta: (tuple?.[2] as string | undefined) ?? null,
    });
    cur = tuple?.[0] as string | undefined;
  }
  return chain;
}

/**
 * The ownership chain as `EntityRef[]` — a projection of {@link parentChain} that drops the
 * pointer payload. The package returns the chain (uuids + types); the product turns it into a path
 * string (it owns the name field).
 */
export function ancestorChain(archive: Y.Doc, uuid: string, asOfCut?: Cut, cutsUpTo?: Cut[]): EntityRef[] {
  return parentChain(archive, uuid, asOfCut, cutsUpTo).map((hop) => hop.ref);
}

/**
 * The target of an entity's `@syncing` REFERENCE field (a non-ownership edge — e.g.
 * `VariantGroup.subject`, `TplComponent.component`), as a typed {@link EntityRef}. A ref field stores
 * the reference tuple `[targetUuid]` as the attribute; this reads + resolves it. `undefined` if the
 * field is absent or the target doesn't resolve. The companion to {@link parentChain}: that walks
 * ownership (`\0`) edges, this follows a named reference edge by one hop.
 */
export function resolveRef(archive: Y.Doc, uuid: string, field: string): EntityRef | undefined {
  const el = xmlElByUuid(archive, uuid);
  const ref = el?.getAttribute(field) as unknown[] | undefined;
  const target = ref?.[0];
  return typeof target === "string" ? refByUuid(archive, target) : undefined;
}

/** True if `uuid` is within any `root`'s subtree, as the tree was at `asOfCut` (or now, if omitted). */
export function isInSubtree(
  archive: Y.Doc,
  uuid: string,
  roots: Set<string>,
  asOfCut?: Cut,
  cutsUpTo?: Cut[],
): boolean {
  return ancestorChain(archive, uuid, asOfCut, cutsUpTo).some((ref) => roots.has(ref.uuid));
}
