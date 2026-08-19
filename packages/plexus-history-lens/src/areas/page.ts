import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/** A page's route (PageMeta.path) changed. `page` is the OWNING page's name (resolved via the owner walk). */
export interface PageRouteChanged extends IntentEventBase {
  kind: "PageRouteChanged";
  page: string;
  from?: string;
  to: string;
}

/** Every intent kind the Page area owns. */
export type PageIntent = PageRouteChanged;

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

/**
 * The Page area — page-scoped settings (the route, for now). One of the TWO TEMPLATE modules (with
 * {@link componentArea}) the fan-out copies; note it OWNS NO BIRTH (a page's birth is a `PageComponent`
 * materialize, owned by the Component area) — it only recognizes the `PageMeta.path` edit, resolving the
 * owning page via {@link LensCtx.ownerOf}.
 */
export const pageArea: AreaModule = {
  name: "Page",

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): PageRouteChanged | null {
    // Page route (PageMeta.path) — resolve the OWNING page's name via the owner walk.
    if (c.verb === "set" && c.field === "path" && c.entity.type === "PageMeta") {
      const ownerUuid = ctx.ownerOf?.(c.entity.uuid, meta.seq);
      const page = (ownerUuid ? ctx.nameOf(ownerUuid, meta.seq) : undefined) ?? "page";
      return {
        kind: "PageRouteChanged",
        page,
        from: c.before === undefined ? undefined : str(c.before),
        to: str(c.after),
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }
    return null;
  },

  humanize(e): string | null {
    if (e.kind === "PageRouteChanged") return `Set "${e.page}" route to ${e.to}`; // DRAFT — V review
    return null;
  },
};
