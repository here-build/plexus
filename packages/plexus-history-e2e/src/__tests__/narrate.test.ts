import { PlainComponent, ProjectPackage, RuleSet, Site, State, TplTag, UnionType, Variant, VariantGroup } from "@here.build/model";
import { changesBetween } from "@here.build/plexus-history";
import { captureCut, type Cut } from "@here.build/plexus-history/capture";
import { type LensCtx, narrateChanges } from "@here.build/plexus-history-lens";
import { ProjectPlexus } from "@here.build/project-plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/*
 * The ASSEMBLY capstone: the WHOLE middle-end over a REAL here.build model — consolidate (Pass 1) STAMPS each
 * event with its object-centric resolution (resolveChange on the anchor), then narrate (Pass 2) groups facets
 * by (object, coordinate) into one human gesture. Subsequent style edits on an EXISTING variant-keyed RuleSet
 * read as "{element} gets {facets} in the {state} state" — lens-architecture.md §4 end-to-end on live data.
 *
 * NB the absorption grain (consolidate.ts ★DECISION): a node's FIRST style CREATES its RuleSet and is absorbed
 * as part of "the node now has this shape". So the gesture comes from the SUBSEQUENT edits (tx2), not the
 * establishing one (tx1). Default uuid mode (decodable) — the decode-by-uuid walk requires it.
 */
describe("narrate over a real here.build model — Pass 1 (stamp) + Pass 2 (group) end-to-end", () => {
  it("subsequent styles on a variant-keyed RuleSet → 'root gets … in the danger state'", () => {
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

    // tx1 — the FIRST style under the danger combo CREATES the RuleSet (absorbed by Pass 1: a node's first
    // style is part of "the node now has this shape", not a standalone gesture — consolidate.ts ★DECISION).
    plexus.transact(() => {
      root.rs.set(new Set([dangerVariant]), new RuleSet({ values: { "background-color": "#DC2626" } }));
    });
    const afterFirstStyle = cuts.length;

    // tx2 — SUBSEQUENT edits to the now-EXISTING danger RuleSet. THESE emit (StylePropertyChanged), each
    // resolving (element root · facet rs · coordinate danger) — two facets of one object under one coordinate.
    plexus.transact(() => {
      const rs = root.rs.get(new Set([dangerVariant]));
      expect(rs, "the danger RuleSet exists after the first style").toBeDefined();
      rs!.assignValues({ "border-width": "2px", color: "#ffffff" });
    });

    const changes = changesBetween(doc, cuts[afterFirstStyle - 1] ?? null, cuts[cuts.length - 1], cuts.slice(afterFirstStyle));

    // Product namer — we hold the live entities (default uuid mode ⇒ live `.uuid` == the archive uuid).
    const names = new Map<string, string>([
      [dangerVariant.uuid, "danger"],
      [root.uuid, "root"],
    ]);
    const ctx: LensCtx = { nameOf: (uuid) => names.get(uuid) };

    // The deliverable: the two facet edits fold into ONE grouped gesture, typed-variance clause and all.
    expect(narrateChanges(changes, ctx, doc)).toEqual(["root gets border width and text color in the danger state"]);
  });
});
