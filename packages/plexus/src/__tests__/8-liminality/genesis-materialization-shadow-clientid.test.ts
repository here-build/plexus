import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { isLiminalClientId, LIMINAL_BASE } from "../../genesis-client.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { Plexus } from "../../Plexus.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { VirtualMap } from "../../proxy-runtime-types.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => {
  enableMobXIntegration();
});

/**
 * Regression guard — the shadow-clientID partition invariant under virtual-genesis
 * materialization, plus the liminal-commit UUID resolution that rides on it.
 *
 * A `@syncing.child.map` set materializes its container Y.Map and declares the entity's
 * type-map via the deterministic genesis machinery. Those genesis writes go through
 * `genesisApplyUpdate`, which MUST keep the transaction `local`: `applyUpdate` forces
 * `local=false`, and at cleanup a `local:false` transaction that advanced the doc's OWN
 * clientID makes Yjs "reroll" it (`Transaction.js:357`) — throwing `shadow.clientID`
 * OUT of the liminal partition and breaking the load-bearing invariant
 *
 *     shadow.clientID === doc.clientID + LIMINAL_BASE        (Plexus.ts:306)
 *
 * on which `extractCommittedDelta`'s `committed = limId + LIMINAL_BASE` arithmetic and
 * `enterLiminality`'s `clientID++` both depend. (CRDT convergence still held under the
 * reroll, so it was SILENT latent corruption — it bit the next liminal op.)
 *
 * These assert the INVARIANT (the measurable state), NOT the console warning (which
 * vitest suppresses). They guard the fix in `genesisApplyUpdate` (keep genesis local)
 * plus the dual-base `deref` resolution that lets a committed (`LIM → CMT`) entity
 * resolve through its still-liminal UUID.
 *
 * This is the CORE child.map mechanism — PlexusText.style is one instance of it; the
 * model here is intentionally minimal so the coverage is model-agnostic.
 */

/** Reach the private shadow doc — the partition invariant lives on its clientID. */
function shadowDoc<R extends PlexusModel>(plexus: Plexus<R>): Y.Doc {
  return (plexus as unknown as { readonly __liminalDocument__: Y.Doc }).__liminalDocument__;
}

@syncing("RedItem")
class RedItem extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("RedContainer")
class RedContainer extends PlexusModel {
  @syncing.child.map accessor items!: Map<string, RedItem>;
}

function freshContainer() {
  return new RedContainer({ items: new Map() });
}

function syncDocs(d1: Y.Doc, d2: Y.Doc) {
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
}

@syncing("RedVHost")
class RedVHost extends PlexusModel {
  @syncing.virtual((key: string) => new RedItem({ name: `auto-${key}` }))
  accessor slots!: VirtualMap<string, RedItem>;
}

describe("shadow-clientID partition survives virtual-genesis materialization", () => {
  it("baseline: the invariant holds on a fresh Plexus (no materialization yet)", () => {
    const { doc, plexus } = initTestPlexus(freshContainer());
    const shadow = shadowDoc(plexus);

    expect(isLiminalClientId(shadow.clientID)).to.equal(true);
    expect(shadow.clientID).to.equal(doc.clientID + LIMINAL_BASE);
  });

  it("a single child.map set must not reroll the shadow out of the liminal partition", () => {
    const { doc, plexus, root } = initTestPlexus(freshContainer());
    const shadow = shadowDoc(plexus);
    const before = shadow.clientID;

    root.items.set("k1", new RedItem({ name: "a" })); // triggers genesis materialization

    expect(shadow.clientID, "shadow clientID must be unchanged by materialization").to.equal(before);
    expect(isLiminalClientId(shadow.clientID), "shadow must stay in the liminal partition").to.equal(true);
    expect(shadow.clientID).to.equal(doc.clientID + LIMINAL_BASE);
  });

  it("the invariant survives many materializations", () => {
    const { doc, plexus, root } = initTestPlexus(freshContainer());
    const shadow = shadowDoc(plexus);

    for (let i = 0; i < 10; i++) root.items.set(`k${i}`, new RedItem({ name: `n${i}` }));

    expect(isLiminalClientId(shadow.clientID)).to.equal(true);
    expect(shadow.clientID).to.equal(doc.clientID + LIMINAL_BASE);
  });

  it("a liminal session opened AFTER a materialization runs in the liminal partition", () => {
    const { plexus, root } = initTestPlexus(freshContainer());
    const shadow = shadowDoc(plexus);

    root.items.set("k", new RedItem({ name: "a" })); // genesis materialization (formerly rerolled)

    // enterLiminality does `shadow.clientID++` — if a materialization had rerolled the
    // base into the regular range, the whole liminal session (and its committed-delta
    // arithmetic) would run off a regular-range base.
    plexus.enterLiminality();
    expect(isLiminalClientId(shadow.clientID), "liminal session must run in the liminal partition").to.equal(true);
    plexus.revertLiminality();
  });
});

describe("the .virtual path (materializeVirtualChild) — path is the argument, not the production", () => {
  // The .virtual path was the reference that revealed the bug: it never rerolled the
  // shadow, which is what isolated the defect to the child.map container path. Both
  // now route their genesis writes through the fixed `genesisApplyUpdate`.
  it("the .virtual path does NOT reroll the shadow", () => {
    const { doc, plexus, root } = initTestPlexus(new RedVHost({}));
    const shadow = shadowDoc(plexus);

    root.slots.get("a"); // auto-materialize the hermetic subtree at path "a"

    expect(isLiminalClientId(shadow.clientID)).to.equal(true);
    expect(shadow.clientID).to.equal(doc.clientID + LIMINAL_BASE);
  });

  it("the subtree at a path is deterministic and converges across peers", () => {
    const { doc: docA, root: rootA } = initTestPlexus(new RedVHost({}));
    rootA.slots.get("a");

    // Peer B materializes the SAME path independently — same deterministic genesis.
    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { root: rootB } = connectTestPlexus<RedVHost>(docB);

    expect(rootB.slots.get("a").name).to.equal("auto-a");
    syncDocs(docA, docB);
    expect(rootA.slots.get("a").name).to.equal(rootB.slots.get("a").name);
  });
});

describe("commitLiminality bundles genesis as external + rewrites the liminal log", () => {
  it("commitLiminality after a liminal materialization keeps the shadow in the liminal partition", () => {
    const { plexus, root } = initTestPlexus(freshContainer());
    const shadow = shadowDoc(plexus);

    plexus.enterLiminality();
    root.items.set("k", new RedItem({ name: "a" })); // liminal genesis materialization
    plexus.commitLiminality();

    expect(isLiminalClientId(shadow.clientID)).to.equal(true);
  });

  it("a liminal child.map materialization survives commit to a fresh peer", () => {
    const { doc, plexus, root } = initTestPlexus(freshContainer());

    plexus.enterLiminality();
    root.items.set("k", new RedItem({ name: "a" }));
    plexus.commitLiminality();

    expect(root.items.get("k")?.name).to.equal("a");

    const fresh = new Y.Doc({ guid: doc.guid });
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    const { root: freshRoot } = connectTestPlexus<RedContainer>(fresh);
    expect(freshRoot.items.get("k")?.name).to.equal("a");
  });
});

describe("cross-peer parallel genesis", () => {
  it("two peers materializing the same path in parallel converge", () => {
    const { doc: docA, root: rootA } = initTestPlexus(new RedVHost({}));
    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { root: rootB } = connectTestPlexus<RedVHost>(docB);

    // Both materialize the same path BEFORE syncing — deterministic genesis must converge.
    const a = rootA.slots.get("shared");
    const b = rootB.slots.get("shared");
    expect(a.name).to.equal("auto-shared");
    expect(b.name).to.equal("auto-shared");

    // Converge to a fixpoint — no further materialization after this point.
    syncDocs(docA, docB);
    syncDocs(docA, docB);

    expect(Y.encodeStateVector(docA)).to.deep.equal(Y.encodeStateVector(docB));
  });

  it("liminal-to-normal: a genesis materialized inside a liminal session reaches a normal peer on commit", () => {
    const { doc: docA, plexus: pA, root: rootA } = initTestPlexus(new RedVHost({}));

    pA.enterLiminality();
    rootA.slots.get("x"); // genesis materialization INSIDE the liminal session
    pA.commitLiminality(); // liminal log rewritten + genesis bundled as external → main

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { root: rootB } = connectTestPlexus<RedVHost>(docB);

    expect(rootB.slots.get("x").name).to.equal("auto-x");
  });

  it("liminal-to-liminal: both peers materialize the same path in liminality and converge on commit", () => {
    const { doc: docA, plexus: pA, root: rootA } = initTestPlexus(new RedVHost({}));
    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { plexus: pB, root: rootB } = connectTestPlexus<RedVHost>(docB);

    // Both produce the SAME path's genesis inside independent liminal sessions.
    pA.enterLiminality();
    pB.enterLiminality();
    expect(rootA.slots.get("shared").name).to.equal("auto-shared");
    expect(rootB.slots.get("shared").name).to.equal("auto-shared");
    pA.commitLiminality();
    pB.commitLiminality();

    // The genesis is external/deterministic, so the committed deltas must converge.
    syncDocs(docA, docB);
    syncDocs(docA, docB);

    expect(rootA.slots.get("shared").name).to.equal("auto-shared");
    expect(rootB.slots.get("shared").name).to.equal("auto-shared");
    expect(Y.encodeStateVector(docA)).to.deep.equal(Y.encodeStateVector(docB));
  });
});
