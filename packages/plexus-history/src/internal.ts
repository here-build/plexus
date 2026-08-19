import { decodePlexusUUID } from "@here.build/plexus/internals";
import * as Y from "yjs";

import type { EntityRef } from "./types.js";

/** Plexus `PlexusWrapper.PARENT_ATTR` — the ownership-pointer attribute key (U+0000). */
export const PARENT_ATTR = String.fromCharCode(0);

/**
 * Resolve a Plexus uuid → its `Y.XmlElement` in the archive, O(1) via the encoded item id.
 * Shared by the lift / operators / point-in-time / tree layers (was duplicated).
 */
export function xmlElByUuid(archive: Y.Doc, uuid: string): Y.XmlElement | undefined {
  try {
    const { clientId, clock } = decodePlexusUUID(uuid as never);
    const t = (
      Y.getItem(archive.store, Y.createID(clientId, clock))?.content as unknown as {
        type?: Y.AbstractType<unknown>;
      }
    )?.type;
    return t instanceof Y.XmlElement ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The parent uuid from an element's `\0` ownership tuple, per the archive's CURRENT tree. */
export function parentUuidOf(el: Y.XmlElement): string | undefined {
  const tuple = el.getAttribute(PARENT_ATTR) as unknown[] | undefined;
  return tuple?.[0] as string | undefined;
}

/**
 * Resolve a uuid (e.g. a parent referenced in a `\0` tuple, or an entity-ref line in a serialized
 * map key) to a typed {@link EntityRef}. Unresolvable → `type: "unknown"` (never throws).
 * Shared by the lift and the combo-key parser.
 */
export function refByUuid(archive: Y.Doc, uuid: string): EntityRef {
  try {
    const { clientId, clock } = decodePlexusUUID(uuid as never);
    const item = Y.getItem(archive.store, Y.createID(clientId, clock));
    const type = (item?.content as unknown as { type?: Y.AbstractType<unknown> })?.type;
    return { uuid, type: type instanceof Y.XmlElement ? type.nodeName : "unknown" };
  } catch {
    return { uuid, type: "unknown" };
  }
}
