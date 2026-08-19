import { Plexus, PlexusModel, syncing } from "@here.build/plexus";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { parseComboKey } from "../combo-key.js";
import { xmlElByUuid } from "../internal.js";
import { parentChain, resolveRef } from "../tree.js";

// NB: uuids here are the real (production) feistel-derived CRDT uuids, never a synthetic/test-only
// id scheme. The history layer resolves an entity by DECODING its uuid back to (clientId, clock)
// (xmlElByUuid); a non-decodable id would break the walk.

describe("parseComboKey — ref-level twin of plexus deserializeKey", () => {
  // Format-only tests: a throwaway doc (refs to bogus uuids resolve to type "unknown" — fine, we
  // assert the PARSE structure here; real ref resolution is proven by the live-storage suite below).
  const doc = new Y.Doc();

  it("Value key → one primitive member", () => {
    expect(parseComboKey('Value\n"role"', doc)).toEqual({ kind: "value", members: [{ value: "role" }] });
  });

  it("empty Set → set kind, no members (the EMPTY_COMBO base entry)", () => {
    expect(parseComboKey("Set", doc)).toEqual({ kind: "set", members: [] });
  });

  it("Array of primitives → ordered value members", () => {
    expect(parseComboKey("Array\n1\n2", doc)).toEqual({ kind: "array", members: [{ value: 1 }, { value: 2 }] });
  });

  it("numeric specials + bigint mirror the wire format", () => {
    expect(parseComboKey("Array\nNaN\nInfinity\n-Infinity\n42n", doc).members).toEqual([
      { value: Number.NaN },
      { value: Infinity },
      { value: -Infinity },
      { value: 42n },
    ]);
  });

  it("entity-ref tuple line → a ref member (unresolvable uuid ⇒ type 'unknown', never throws)", () => {
    const combo = parseComboKey('Set\n["not-a-real-uuid"]', doc);
    expect(combo).toEqual({ kind: "set", members: [{ ref: { uuid: "not-a-real-uuid", type: "unknown" } }] });
  });

  it("Value key with ≠1 member throws (loud, not a silent miss)", () => {
    expect(() => parseComboKey("Value\n1\n2", doc)).toThrow(/exactly one member/);
  });

  it("unknown prefix throws", () => {
    expect(() => parseComboKey("Bogus\n1", doc)).toThrow(/invalid prefix/i);
  });
});

/*
 * The gold-standard proof: a REAL Plexus `@syncing.child.map` keyed by `Set<entity>` — the exact
 * storage shape of `TplNode.rs: Map<Set<Variant>, RuleSet>`. Plexus's own child-map.test.ts proves
 * the `\0` tuple is `[parentUuid, field, serializeKey(key)]`; here we prove the resolver CONSUMES it:
 * parentChain reads field + comboMeta, parseComboKey recovers the key-entity's ref, and the entity's
 * display name is readable straight from the archive. (Models named to mirror TplNode/RuleSet/Variant.)
 */
@syncing("HistVariant")
class HVariant extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("HistRuleSet")
class HRuleSet extends PlexusModel {
  @syncing accessor color!: string;
}

@syncing("HistRsNode")
class HRsNode extends PlexusModel {
  @syncing.child.map accessor rs!: Map<Set<HVariant>, HRuleSet>;
}

describe("parentChain + parseComboKey over real Plexus child-map storage", () => {
  it("recovers (object · field/facet · variant-combo coordinate) from a variant-keyed RuleSet", () => {
    const node = new HRsNode({ rs: new Map() });
    const plexus = Plexus.bootstrap(node);
    const doc = plexus.doc;
    const root = plexus.root as HRsNode;

    const variant = new HVariant({ name: "hovered" });
    const rs = new HRuleSet({ color: "red" });
    root.rs.set(new Set([variant]), rs); // base would be `new Set()` (EMPTY_COMBO); this is the "hovered" combo

    const chain = parentChain(doc, rs.uuid);

    // hop[0] = the RuleSet itself, carrying its pointer INTO the node: field "rs" (→ styling facet)
    // + comboMeta = the serialized variant combo (→ coordinate).
    expect(chain[0].ref).toEqual({ uuid: rs.uuid, type: "HistRuleSet" });
    expect(chain[0].field).toBe("rs");
    expect(chain[0].comboMeta).not.toBeNull();

    // The coordinate: the combo parses back to the variant's ref (no live model — uuid + type).
    const combo = parseComboKey(chain[0].comboMeta!, doc);
    expect(combo.kind).toBe("set");
    expect(combo.members).toEqual([{ ref: { uuid: variant.uuid, type: "HistVariant" } }]);

    // The object: walk up to the node (the RuleSet is application-path; the node is the named subject).
    const objectHop = chain.find((h) => h.ref.type === "HistRsNode");
    expect(objectHop?.ref.uuid).toBe(root.uuid);

    // The variant's display name is readable straight from the archive (what ctx.nameOf will do).
    expect(xmlElByUuid(doc, variant.uuid)?.getAttribute("name")).toBe("hovered");
  });

  it("base entry (EMPTY_COMBO) → comboMeta parses to an empty set", () => {
    const node = new HRsNode({ rs: new Map() });
    const plexus = Plexus.bootstrap(node);
    const root = plexus.root as HRsNode;

    const baseRs = new HRuleSet({ color: "black" });
    root.rs.set(new Set(), baseRs);

    const chain = parentChain(plexus.doc, baseRs.uuid);
    expect(chain[0].field).toBe("rs");
    expect(parseComboKey(chain[0].comboMeta!, plexus.doc)).toEqual({ kind: "set", members: [] });
  });
});

/*
 * resolveRef + the variant→group→subject walk, mirroring VariantGroup: a `subject` REF (to a State
 * owned elsewhere) + a `variants` child-list. This is exactly the walk the lens's typed-variance does
 * to recover a combo's KIND (subject nodeName) — proven here against real Plexus storage, in core.
 */
@syncing("HistState")
class HState extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("HistVGroup")
class HVGroup extends PlexusModel {
  @syncing accessor subject!: HState; // ref (not child) — mirrors VariantGroup.subject
  @syncing.child.list accessor variants!: HVariant[];
}

@syncing("HistVRoot")
class HVRoot extends PlexusModel {
  @syncing.child accessor group!: HVGroup | null;
  @syncing.child accessor state!: HState | null; // the subject is owned HERE; the group only refs it
}

describe("resolveRef + the variant→group→subject walk over real Plexus storage", () => {
  it("resolveRef reads a @syncing ref field → the target's typed EntityRef", () => {
    const state = new HState({ name: "danger" });
    const group = new HVGroup({ subject: state, variants: [] });
    const root = new HVRoot({ group, state });
    const plexus = Plexus.bootstrap(root);

    expect(resolveRef(plexus.doc, group.uuid, "subject")).toEqual({ uuid: state.uuid, type: "HistState" });
    expect(resolveRef(plexus.doc, group.uuid, "nonexistent")).toBeUndefined();
  });

  it("variant → parentChain[1] (the group) → resolveRef('subject') → the subject type (the KIND source)", () => {
    const state = new HState({ name: "danger" });
    const variant = new HVariant({ name: "danger" });
    const group = new HVGroup({ subject: state, variants: [variant] });
    const root = new HVRoot({ group, state });
    const plexus = Plexus.bootstrap(root);

    const chain = parentChain(plexus.doc, variant.uuid);
    expect(chain[1].ref.type).toBe("HistVGroup"); // a variant's owner is its group (child-list)
    expect(resolveRef(plexus.doc, chain[1].ref.uuid, "subject")?.type).toBe("HistState"); // → component-state kind
  });
});
