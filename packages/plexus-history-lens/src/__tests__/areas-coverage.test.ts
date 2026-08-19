import type { PlexusChange } from "@here.build/plexus-history";
import { describe, expect, it } from "vitest";

import { consolidate, type LensCtx } from "../consolidate.js";
import { humanize } from "../humanize.js";

/**
 * Synthetic-change coverage: drive each AREA through `consolidate` with hand-built PlexusChange[]
 * (no toy model, no agents). Proves the recognizers FIRE on the expected change shapes — the
 * behavioral demonstration of the wired areas. Wording is DRAFT (V's later feedback loop); these
 * assert the STRUCTURE (the right intent kind), not the phrasing.
 */

const names: Record<string, string> = {
  uEH: "onClick", uNav: "nav", uDS: "Users API", uQ: "userQuery", uOp: "computeTotal",
  uCmt: "a comment", uSplit: "pricing-test", uNpm: "axios", uArena: "Main", uFrame: "Desktop",
  uProj: "MyApp", uTag: "header", uTok: "brand-blue", uVar: "hover", uSite: "Site",
};
const ctx: LensCtx = { nameOf: (u) => names[u], ownerOf: (u) => (u === "uEH" || u === "uNav" ? "uTag" : undefined) };
const author = { userId: "alice", kind: "human" as const };
const ch = (p: Partial<PlexusChange> & Pick<PlexusChange, "verb" | "entity">): PlexusChange => ({ seq: 1, timestamp: 1, author, ...p });
const run = (changes: PlexusChange[]): ReturnType<typeof consolidate> => consolidate(changes, ctx);

describe("Behavior area", () => {
  it("materialized EventHandler → BehaviorAdded(event)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uEH", type: "EventHandler" } })])).toMatchObject([{ kind: "BehaviorAdded", handlerKind: "event" }]);
  });
  it("materialized SignalHandler → BehaviorAdded(reactive)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uEH", type: "SignalHandler" } })])).toMatchObject([{ kind: "BehaviorAdded", handlerKind: "reactive" }]);
  });
  it("NavigationAction target set → NavigationChanged", () => {
    expect(run([ch({ verb: "set", entity: { uuid: "uNav", type: "NavigationAction" }, field: "href", after: "/home" })])).toMatchObject([{ kind: "NavigationChanged" }]);
  });
  it("detached EventHandler → BehaviorRemoved", () => {
    expect(run([ch({ verb: "detach", entity: { uuid: "uEH", type: "EventHandler" } })])).toMatchObject([{ kind: "BehaviorRemoved" }]);
  });
});

describe("Data area", () => {
  it("materialized DataSourceDefinition → DataSourceChanged(add)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uDS", type: "DataSourceDefinition" } })])).toMatchObject([{ kind: "DataSourceChanged", subKind: "add" }]);
  });
  it("materialized ComponentDataQuery → QueryChanged(add)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uQ", type: "ComponentDataQuery" } })])).toMatchObject([{ kind: "QueryChanged", subKind: "add" }]);
  });
  it("materialized ValueOperation → OperationChanged(add)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uOp", type: "ValueOperation" } })])).toMatchObject([{ kind: "OperationChanged", subKind: "add" }]);
  });
  it("materialized Split → SplitChanged(add)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uSplit", type: "Split" } })])).toMatchObject([{ kind: "SplitChanged", subKind: "add" }]);
  });
  it("Comment: materialized → post; resolved set → resolve", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uCmt", type: "Comment" } })])).toMatchObject([{ kind: "CommentEvent", subKind: "post" }]);
    expect(run([ch({ verb: "set", entity: { uuid: "uCmt", type: "Comment" }, field: "resolved", after: true })])).toMatchObject([{ kind: "CommentEvent", subKind: "resolve" }]);
  });
});

describe("Project area", () => {
  it("ProjectPackage name set → ProjectRenamed", () => {
    expect(run([ch({ verb: "set", entity: { uuid: "uProj", type: "ProjectPackage" }, field: "name", before: "MyApp", after: "MyApp2" })])).toMatchObject([{ kind: "ProjectRenamed", from: "MyApp", to: "MyApp2" }]);
  });
  it("materialized Arena → ArenaChanged(added)", () => {
    expect(run([ch({ verb: "materialized", entity: { uuid: "uArena", type: "Arena" } })])).toMatchObject([{ kind: "ArenaChanged", subKind: "added" }]);
  });
  it("ArenaFrame width set → ArtboardChanged(resized)", () => {
    expect(run([ch({ verb: "set", entity: { uuid: "uFrame", type: "ArenaFrame" }, field: "width", before: 100, after: 200 })])).toMatchObject([{ kind: "ArtboardChanged", subKind: "resized" }]);
  });
  it("Site flags record entry set (key-bearing, C2) → SiteConfigChanged(flag)", () => {
    expect(run([ch({ verb: "set", entity: { uuid: "uSite", type: "Site" }, field: "flags", key: "darkMode", after: true })])).toMatchObject([{ kind: "SiteConfigChanged", subKind: "flag", entryKey: "darkMode" }]);
  });
});

describe("Wired areas recognize (not RawEdit)", () => {
  it("tpl-tree: non-fresh TplTag name set → recognized", () => {
    const e = run([ch({ verb: "set", entity: { uuid: "uTag", type: "TplTag" }, field: "name", before: "header", after: "nav" })]);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0].kind).not.toBe("RawEdit");
  });
  it("tokens: materialized ColorToken → recognized", () => {
    const e = run([ch({ verb: "materialized", entity: { uuid: "uTok", type: "ColorToken" } })]);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0].kind).not.toBe("RawEdit");
  });
  it("variants: materialized Variant → recognized", () => {
    const e = run([ch({ verb: "materialized", entity: { uuid: "uVar", type: "Variant" } })]);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0].kind).not.toBe("RawEdit");
  });
});

describe("total coverage: every event humanizes (no null lines)", () => {
  it("a representative cross-area cut produces only non-empty humanized lines", () => {
    const events = run([
      ch({ seq: 5, verb: "materialized", entity: { uuid: "uEH", type: "EventHandler" } }),
      ch({ seq: 5, verb: "set", entity: { uuid: "uProj", type: "ProjectPackage" }, field: "name", before: "MyApp", after: "MyApp2" }),
    ]);
    const text = humanize(events);
    expect(text.length).toBeGreaterThan(0);
    expect(text.split("\n").every((l) => l.trim().length > 0)).toBe(true);
  });
});
