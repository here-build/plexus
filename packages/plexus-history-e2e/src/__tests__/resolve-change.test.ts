import { PlainComponent, ProjectPackage, RuleSet, Site, State, TplTag, UnionType, Variant, VariantGroup } from "@here.build/model";
import { changesBetween } from "@here.build/plexus-history";
import { captureCut, type Cut } from "@here.build/plexus-history/capture";
import { type LensCtx, resolveChange } from "@here.build/plexus-history-lens";
import { ProjectPlexus } from "@here.build/project-plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/*
 * The capstone: the WHOLE resolver spine over a REAL here.build model — parentChain → resolveTarget →
 * parseComboKey → variant→group→subject walk → resolveVarianceCoord. A red background set under a
 * "danger" State variant resolves to (element · rs · component-state[danger]) — "in the danger state".
 * Construction copied from model/utils/__tests__/transform-layer.test.ts (a proven VariantGroup shape).
 * Default uuid mode (decodable) — NOT arbitrary, which the decode-by-uuid walk requires.
 */
describe("resolveChange over a real here.build model — object · facet · coordinate capstone", () => {
  it("a variant-keyed style resolves to (element · rs · component-state[danger])", () => {
    const doc = new Y.Doc({ gc: false }); // gc:false — changesBetween reads a cold archive
    const cuts: Cut[] = [];
    doc.on("update", (_u, _o, _d, tr) => cuts.push(captureCut(tr, { seq: cuts.length, timestamp: cuts.length, author: null })));

    const dangerVariant = new Variant({ name: "danger" });
    const dangerState = new State({ name: "danger", type: new UnionType({ source: null }) });
    const dangerGroup = new VariantGroup({ name: "danger", subject: dangerState, variants: [dangerVariant], standalone: true });
    const root = new TplTag({ tag: "button", name: "root" });
    const button = new PlainComponent({ name: "Button", tplTree: root, states: [dangerState], variantGroups: [dangerGroup] });
    const plexus = ProjectPlexus.bootstrap(
      new ProjectPackage({ site: new Site({ components: [button] }), projectId: "p" as never, name: "toy", version: "0.0.0" }),
      "doc",
      doc,
    );
    const afterSeed = cuts.length;

    // The mutation under test: a red background on the root <button>, under the "danger" combo.
    plexus.transact(() => {
      root.rs.set(new Set([dangerVariant]), new RuleSet({ values: { "background-color": "#DC2626" } }));
    });

    const changes = changesBetween(doc, cuts[afterSeed - 1] ?? null, cuts[cuts.length - 1], cuts.slice(afterSeed));

    // Product namer — we hold the live entities, so map their uuids → display names (default uuid mode
    // ⇒ live `.uuid` equals the archive uuid the walk recovers).
    const names = new Map<string, string>([
      [dangerVariant.uuid, "danger"],
      [root.uuid, "root"],
    ]);
    const ctx: LensCtx = { nameOf: (uuid) => names.get(uuid) };

    // (1) the child-map set ON the element: rs[<combo>] = the RuleSet (k=0; combo rides in change.key).
    const rsSet = changes.find((c) => c.verb === "set" && c.field === "rs");
    expect(rsSet, "a set on the element's `rs` child-map").toBeDefined();
    expect(resolveChange(rsSet!, doc, ctx)).toMatchObject({
      object: { type: "TplTag", uuid: root.uuid, name: "root" },
      facet: "rs",
      coordinate: { kind: "component-state", variants: ["danger"] },
    });

    // (2) the CSS value set INSIDE the RuleSet resolves to the SAME object + coordinate (the deep k>0
    // path — the combo is recovered from the element↔RuleSet boundary, not the RuleSet's own hop).
    const valueSet = changes.find((c) => c.entity.type === "RuleSet" && c.verb === "set");
    expect(valueSet, "a value set inside the RuleSet").toBeDefined();
    expect(resolveChange(valueSet!, doc, ctx)).toMatchObject({
      object: { type: "TplTag", uuid: root.uuid },
      facet: "rs",
      coordinate: { kind: "component-state", variants: ["danger"] },
    });
  });
});
