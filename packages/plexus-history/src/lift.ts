import { encodePlexusUUID } from "@here.build/plexus/internals";
import * as Y from "yjs";

import { rawChangesBetween } from "./raw.js";
import { refByUuid } from "./internal.js";
import type { CutLog, CutRef } from "./cut-log.js";
import type { Cut, EntityRef, PlexusChange, RawChange, Verb } from "./types.js";

// ── Resolution helpers (the lift's Plexus-awareness) ──────────────────────────

/** Entity uuid from its XmlElement = encode of the element's own item id (O(1)). */
function entityRefOf(xmlEl: Y.XmlElement): EntityRef | null {
  const item = (xmlEl as unknown as { _item: { id: { client: number; clock: number } } | null })._item;
  if (!item) return null; // root / unmaterialized
  return { uuid: encodePlexusUUID(item.id.client, item.id.clock), type: xmlEl.nodeName };
}

/**
 * The JS value a struct carries AT a specific clock. Yjs merges adjacent deleted items
 * into one multi-length struct (content = an array of values), so the value for clock C
 * is `getContent()[C - baseClock]`, not `[length-1]`.
 */
function decodeValue(item: Y.Item, clock: number): unknown {
  const content = item.content as unknown as { getContent?: () => unknown[] };
  return content.getContent?.()[clock - item.id.clock];
}

type Container = { kind: "attr" | "array" | "map"; xmlEl: Y.XmlElement; field: string; key?: string };

/** Locate the owning entity XmlElement + field for a changed struct. */
function resolveContainer(item: Y.Item): Container | null {
  const parent = item.parent;
  if (parent instanceof Y.XmlElement) return { kind: "attr", xmlEl: parent, field: item.parentSub ?? "" };
  if (parent instanceof Y.Array || parent instanceof Y.Map) {
    const owner = (parent as unknown as { _item: Y.Item | null })._item;
    if (owner && owner.parent instanceof Y.XmlElement) {
      const isMap = parent instanceof Y.Map;
      // A Y.Map entry carries its own key in item.parentSub (the CSS prop / attr / flag name);
      // a Y.Array element is positional (no string key).
      return {
        kind: isMap ? "map" : "array",
        xmlEl: owner.parent,
        field: owner.parentSub ?? "",
        ...(isMap && item.parentSub != null ? { key: item.parentSub } : {}),
      };
    }
  }
  return null;
}

function contentType(item: Y.Item): Y.AbstractType<unknown> | undefined {
  return (item.content as unknown as { type?: Y.AbstractType<unknown> }).type;
}

function stamp(cut: Cut, partial: Omit<PlexusChange, "seq" | "timestamp" | "author">): PlexusChange {
  return { seq: cut.seq, timestamp: cut.timestamp, author: cut.author, ...partial };
}

const PARENT_ATTR = String.fromCharCode(0); // Plexus PlexusWrapper.PARENT_ATTR (U+0000)

// ── The lift: raw structs (one frame) → semantic PlexusChange[] ───────────────

function liftFrame(rawChanges: RawChange[], cut: Cut, archive: Y.Doc): PlexusChange[] {
  const out: PlexusChange[] = [];
  // Keyed-container changes are paired (a set/overwrite = insert of the new + delete of the prior, same
  // txn): XmlElement attrs (key = the attribute name, carried in `field`) AND Y.Map/record entries (key =
  // the entry's parentSub, carried in `key`). Y.Array elements stay positional insert/remove (no string key).
  const groups = new Map<string, { entity: EntityRef; field: string; key?: string; insert?: RawChange; delete?: RawChange }>();
  // Y.Array elements are positional (no string key) — buffered per (entity, field) so a same-value
  // insert+remove in one cut can be recognized as a reorder (C3) rather than a spurious remove+insert.
  const arrayGroups = new Map<string, { entity: EntityRef; field: string; inserts: Map<string, unknown>; removes: Map<string, unknown> }>();

  for (const rc of rawChanges) {
    const item = rc.item;
    const ct = contentType(item);

    // materialized: an XmlElement entity placed into the doc.
    if (rc.kind === "insert" && ct instanceof Y.XmlElement) {
      const e = entityRefOf(ct);
      if (e) out.push(stamp(cut, { verb: "materialized", entity: e }));
      continue;
    }
    // collection-container creation (the empty Y.Array/Y.Map attribute) — its elements carry meaning.
    if (ct instanceof Y.Array || ct instanceof Y.Map) continue;

    const c = resolveContainer(item);
    if (!c) continue; // root / typeMap-level struct not under an entity — TODO
    const entity = entityRefOf(c.xmlEl);
    if (!entity) continue;

    // Attrs and Y.Map/record entries are both keyed → group + pair (set/clear). Arrays stay positional.
    if (c.kind === "attr" || c.kind === "map") {
      const gkey = `${entity.uuid} ${c.field} ${c.key ?? ""}`;
      const g = groups.get(gkey) ?? { entity, field: c.field, key: c.key };
      g[rc.kind] = rc;
      groups.set(gkey, g);
    } else {
      // Y.Array element: buffer by (entity, field); pairing happens after the loop (C3).
      const value = decodeValue(item, rc.id.clock);
      const akey = `${entity.uuid} ${c.field}`;
      const ag = arrayGroups.get(akey) ?? { entity, field: c.field, inserts: new Map<string, unknown>(), removes: new Map<string, unknown>() };
      (rc.kind === "insert" ? ag.inserts : ag.removes).set(JSON.stringify(value), value);
      arrayGroups.set(akey, ag);
    }
  }

  for (const g of groups.values()) {
    const ins = g.insert;
    const del = g.delete;
    const insVal = ins ? decodeValue(ins.item, ins.id.clock) : undefined;
    const delVal = del ? decodeValue(del.item, del.id.clock) : undefined;
    const keyPart = g.key !== undefined ? { key: g.key } : {};
    if (g.field === PARENT_ATTR) {
      // ownership pointer: reparent (new value) or detach (cleared). The \0 tuple is
      // [parentUuid, childListKey, meta?] — C5: tuple[1] (children/slots/eventHandlers/tplTree/…)
      // rides in `field` so a consumer knows WHICH of a parent's child-lists received the child.
      if (ins) {
        const to = (insVal as unknown[] | undefined)?.[0] as string | undefined;
        const from = (delVal as unknown[] | undefined)?.[0] as string | undefined;
        const listKey = (insVal as unknown[] | undefined)?.[1] as string | undefined;
        out.push(
          stamp(cut, {
            verb: "reparent",
            entity: g.entity,
            ...(listKey !== undefined ? { field: listKey } : {}),
            ...(from ? { from: refByUuid(archive, from) } : {}),
            ...(to ? { to: refByUuid(archive, to) } : {}),
          }),
        );
      } else if (del) {
        const from = (delVal as unknown[] | undefined)?.[0] as string | undefined;
        const listKey = (delVal as unknown[] | undefined)?.[1] as string | undefined;
        out.push(stamp(cut, { verb: "detach", entity: g.entity, ...(listKey !== undefined ? { field: listKey } : {}), ...(from ? { from: refByUuid(archive, from) } : {}) }));
      }
    } else if (ins) {
      out.push(stamp(cut, { verb: "set", entity: g.entity, field: g.field, ...keyPart, ...(del ? { before: delVal } : {}), after: insVal }));
    } else if (del) {
      out.push(stamp(cut, { verb: "clear", entity: g.entity, field: g.field, ...keyPart, before: delVal }));
    }
  }

  // Y.Array elements (C3): a value both inserted AND removed in this cut on the same list moved position
  // → one `reorder` (the moved value in `after`); otherwise a genuine insert / remove. Cross-list moves
  // don't pair here (different fields, + a \0 reparent). TODO: destination index needs as-of-cut array
  // reconstruction (the live archive reflects the latest order, not this cut's) — left off for now.
  for (const ag of arrayGroups.values()) {
    for (const [vk, value] of ag.inserts) {
      if (ag.removes.delete(vk)) out.push(stamp(cut, { verb: "reorder", entity: ag.entity, field: ag.field, after: value }));
      else out.push(stamp(cut, { verb: "insert", entity: ag.entity, field: ag.field, after: value }));
    }
    for (const value of ag.removes.values()) {
      out.push(stamp(cut, { verb: "remove", entity: ag.entity, field: ag.field, before: value }));
    }
  }

  return out;
}

/**
 * The PUBLIC read boundary: semantic, plain-JSON changes between two cuts, each stamped
 * with its owning cut's provenance (seq/timestamp/author).
 *
 * `archive` MUST be gc:false. Throws {@link import("./types.js").MissingStructError} on an
 * unresolvable delete. `cutsInRange` = the cuts with seq in (cutA.seq, cutB.seq], in order.
 */
export function changesBetween(archive: Y.Doc, cutA: Cut | null, cutB: Cut, cutsInRange: Cut[]): PlexusChange[] {
  void cutB; // bounds are expressed by cutsInRange; cutB retained for signature symmetry
  const out: PlexusChange[] = [];
  let prev = cutA;
  for (const cut of cutsInRange) {
    out.push(...liftFrame(rawChangesBetween(archive, prev, cut, [cut]), cut, archive));
    prev = cut;
  }
  return out;
}

/**
 * Convenience over {@link changesBetween}: resolve `fromRef`/`toRef` against the cut-log and
 * assemble `cutsInRange` internally (no redundant `(cutB, cutsInRange)` to keep consistent).
 * `fromRef = null` ⇒ from genesis. Returns `[]` if `toRef` doesn't resolve.
 */
export function changesByRef(
  archive: Y.Doc,
  cutLog: CutLog,
  fromRef: CutRef | null,
  toRef: CutRef,
): PlexusChange[] {
  const from = fromRef === null ? null : (cutLog.resolveRef(fromRef) ?? null);
  const to = cutLog.resolveRef(toRef);
  if (!to) return [];
  const cuts = cutLog.range((from?.seq ?? -1) + 1, to.seq);
  return changesBetween(archive, from, to, cuts);
}

export type { Verb };
