import type { PlexusChange } from "@here.build/plexus-history";
import { describe, expect, it } from "vitest";

import { consolidate, type LensCtx } from "../consolidate.js";
import { humanize } from "../humanize.js";

const CARD = "uCard";
const ROOT = "uRoot";
const SITE = "uSite";
const BTN = "uBtn";
const PM = "uPageMeta";
const PAGE = "uPage";

const names: Record<string, string> = { [CARD]: "Card", [BTN]: "PrimaryButton", [PAGE]: "HomePage" };
const ctx: LensCtx = { nameOf: (u) => names[u], ownerOf: (u) => (u === PM ? PAGE : undefined) };

const author = { userId: "alice", kind: "human" as const };
function ch(p: Partial<PlexusChange> & Pick<PlexusChange, "verb" | "entity">): PlexusChange {
  return { seq: 0, timestamp: 0, author, ...p };
}

describe("consolidate (lens MVP)", () => {
  it("the flagship: an add-component cascade (~11 changes) collapses to ONE ComponentAdded", () => {
    const seq = 3;
    // The toy add-Card cut: materialize the component + its root tag, set defaults, reparent, link.
    const changes: PlexusChange[] = [
      ch({ seq, verb: "materialized", entity: { uuid: CARD, type: "PlainComponent" } }),
      ch({ seq, verb: "materialized", entity: { uuid: ROOT, type: "TplTag" } }),
      ch({ seq, verb: "insert", entity: { uuid: SITE, type: "Site" }, field: "components", after: [CARD] }), // Plexus child-list element = [uuid] tuple
      ch({ seq, verb: "set", entity: { uuid: CARD, type: "PlainComponent" }, field: "name", after: "Card" }),
      ch({ seq, verb: "reparent", entity: { uuid: ROOT, type: "TplTag" }, field: "tplTree", to: { uuid: CARD, type: "PlainComponent" } }),
      ch({ seq, verb: "set", entity: { uuid: ROOT, type: "TplTag" }, field: "tag", after: "div" }),
      ch({ seq, verb: "set", entity: { uuid: ROOT, type: "TplTag" }, field: "name", after: "root" }),
      ch({ seq, verb: "set", entity: { uuid: ROOT, type: "TplTag" }, field: "locked", after: false }),
      ch({ seq, verb: "set", entity: { uuid: CARD, type: "PlainComponent" }, field: "hiddenFromContentEditor", after: false }),
      ch({ seq, verb: "set", entity: { uuid: CARD, type: "PlainComponent" }, field: "trapsFocus", after: false }),
      ch({ seq, verb: "reparent", entity: { uuid: CARD, type: "PlainComponent" }, field: "components", to: { uuid: SITE, type: "Site" } }),
    ];
    const events = consolidate(changes, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ComponentAdded", name: "Card", componentType: "component" });
    expect(humanize(events)).toBe(`Added component "Card"`);
  });

  it("a non-fresh name set → ComponentRenamed", () => {
    const events = consolidate(
      [ch({ seq: 1, verb: "set", entity: { uuid: BTN, type: "PlainComponent" }, field: "name", before: "Button", after: "PrimaryButton" })],
      ctx,
    );
    expect(events).toMatchObject([{ kind: "ComponentRenamed", from: "Button", to: "PrimaryButton" }]);
    expect(humanize(events)).toBe(`Renamed component "Button" → "PrimaryButton"`);
  });

  it("a PageMeta.path set → PageRouteChanged with the owning page resolved", () => {
    const events = consolidate(
      [ch({ seq: 2, verb: "set", entity: { uuid: PM, type: "PageMeta" }, field: "path", before: "/", after: "/landing" })],
      ctx,
    );
    expect(events).toMatchObject([{ kind: "PageRouteChanged", page: "HomePage", to: "/landing" }]);
    expect(humanize(events)).toBe(`Set "HomePage" route to /landing`);
  });

  it("the whole toy scenario across 3 cuts → 3 clean lines (no uuids, no noise)", () => {
    const all: PlexusChange[] = [
      ch({ seq: 1, verb: "set", entity: { uuid: BTN, type: "PlainComponent" }, field: "name", before: "Button", after: "PrimaryButton" }),
      ch({ seq: 2, verb: "set", entity: { uuid: PM, type: "PageMeta" }, field: "path", before: "/", after: "/landing" }),
      ch({ seq: 3, verb: "materialized", entity: { uuid: CARD, type: "PlainComponent" } }),
      ch({ seq: 3, verb: "set", entity: { uuid: CARD, type: "PlainComponent" }, field: "name", after: "Card" }),
      ch({ seq: 3, verb: "reparent", entity: { uuid: CARD, type: "PlainComponent" }, field: "components", to: { uuid: SITE, type: "Site" } }),
    ];
    expect(humanize(consolidate(all, ctx))).toBe(
      ['Renamed component "Button" → "PrimaryButton"', 'Set "HomePage" route to /landing', 'Added component "Card"'].join("\n"),
    );
  });
});
