import type { ChainHop, PlexusChange } from "@here.build/plexus-history";
import { describe, expect, it } from "vitest";

import { resolveTarget } from "../resolve-target.js";

// ── synthetic builders (the pure resolver needs no archive/model) ──
const change = (entity: { uuid: string; type: string }, rest: Partial<PlexusChange> = {}): PlexusChange => ({
  seq: 1,
  timestamp: 0,
  author: null,
  verb: "set",
  entity,
  ...rest,
});

const hop = (uuid: string, type: string, field: string | null = null, comboMeta: string | null = null): ChainHop => ({
  ref: { uuid, type },
  field,
  comboMeta,
});

const COMBO = 'Set\n["v-hovered"]';

describe("resolveTarget — locate (object · facet · coordinate) from a change + its \\0 chain", () => {
  it("change directly ON the object (rename) → facet = the changed field, no coordinate", () => {
    const c = change({ uuid: "c1", type: "PlainComponent" }, { field: "name", after: "Card" });
    const chain = [hop("c1", "PlainComponent")];
    expect(resolveTarget(c, chain)).toEqual({
      object: { uuid: "c1", type: "PlainComponent" },
      facet: "name",
      coordinateMeta: null,
      change: c,
    });
  });

  it("app-path descendant (RuleSet CSS value) → object = element, facet = 'rs', coordinate = the boundary combo", () => {
    // entity is the RuleSet; the variant combo rides on the RuleSet's pointer INTO the node.
    const c = change({ uuid: "rs1", type: "RuleSet" }, { field: "_values", key: "background", after: "red" });
    const chain = [hop("rs1", "RuleSet", "rs", COMBO), hop("n1", "TplTag")];
    expect(resolveTarget(c, chain)).toEqual({
      object: { uuid: "n1", type: "TplTag" },
      facet: "rs",
      coordinateMeta: COMBO, // change.key ("background") is the CSS prop (a fragment detail), NOT the coordinate
      change: c,
    });
  });

  it("child-map set directly on the object → coordinate is the change's own key (the serialized combo)", () => {
    // "added a RuleSet under [hovered]": set node.rs[<combo>] = [rsUuid]. entity = node, key = the combo.
    const c = change({ uuid: "n1", type: "TplTag" }, { field: "rs", key: COMBO, after: ["rs1"] });
    const chain = [hop("n1", "TplTag")];
    expect(resolveTarget(c, chain)).toEqual({
      object: { uuid: "n1", type: "TplTag" },
      facet: "rs",
      coordinateMeta: COMBO,
      change: c,
    });
  });

  it("deeper app-path nesting → coordinate is the object↔child boundary hop, not the change's own hop", () => {
    // change on X, owned by a RuleSet, owned by the node. Coordinate = RuleSet's combo (boundary), not X's.
    const c = change({ uuid: "x1", type: "ShadowLayer" }, { field: "color", after: "#000" });
    const chain = [hop("x1", "ShadowLayer", "shadowLayers"), hop("rs1", "RuleSet", "rs", COMBO), hop("n1", "TplTag")];
    expect(resolveTarget(c, chain)).toMatchObject({
      object: { uuid: "n1", type: "TplTag" },
      facet: "rs",
      coordinateMeta: COMBO,
    });
  });

  it("no named object up the chain → null (caller degrades to a raw edit)", () => {
    const c = change({ uuid: "rs1", type: "RuleSet" }, { field: "_values", key: "color" });
    const chain = [hop("rs1", "RuleSet", "rs", COMBO)]; // detached / object missing
    expect(resolveTarget(c, chain)).toBeNull();
  });

  it("default object-set: TplTag/PlainComponent/State/StyleToken are objects; RuleSet/Variant are not", () => {
    const onObj = (type: string) => resolveTarget(change({ uuid: "e", type }), [hop("e", type)]) !== null;
    expect([onObj("TplTag"), onObj("PlainComponent"), onObj("State"), onObj("StyleToken")]).toEqual([true, true, true, true]);
    expect([onObj("RuleSet"), onObj("Variant"), onObj("VariantGroup"), onObj("AttributesSet")]).toEqual([false, false, false, false]);
  });

  it("isObject is injectable — a custom roster overrides the default", () => {
    const c = change({ uuid: "rs1", type: "RuleSet" }, { field: "_values" });
    const chain = [hop("rs1", "RuleSet", "rs", COMBO), hop("w1", "Widget")];
    expect(resolveTarget(c, chain, (t) => t === "Widget")).toMatchObject({ object: { uuid: "w1", type: "Widget" }, facet: "rs" });
  });
});
