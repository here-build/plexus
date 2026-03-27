/**
 * Awareness Liminality Tests
 *
 * Two Plexus instances on synced docs. One enters liminality.
 * The other sees changes via awareness (Yjs binary delta).
 * On commit: values persist via normal sync. On revert: changes vanish.
 *
 * The awareness protocol carries the scratchpad delta — same format
 * for scalar and structural changes. The receiver applies it to their
 * own scratchpad (shadow doc) for preview.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ── Test model ──

@syncing("AwareEntity")
class AwareEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
}

// ── Sync helpers ──

function syncDocs(doc1: Y.Doc, doc2: Y.Doc) {
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
}

/**
 * Simulate awareness broadcast: encode liminal delta from sender's scratchpad,
 * apply to receiver's shadow doc.
 */
function broadcastLiminalDelta(
  senderPlexus: TestPlexus<AwareEntity>,
  receiverShadow: Y.Doc,
  mainStateVector: Uint8Array,
): Uint8Array {
  const session = senderPlexus.__liminalSession__!;
  const delta = Y.encodeStateAsUpdate(session.scratchDoc, mainStateVector);
  Y.applyUpdate(receiverShadow, delta);
  return delta;
}

/**
 * Read a value from a shadow doc's entity by type+uuid path.
 */
function readFromShadow(shadow: Y.Doc, typeName: string, uuid: string, field: string): any {
  const types = shadow.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
  const subMap = types.get(typeName);
  if (!subMap) return undefined;
  const el = subMap.get(uuid);
  if (!el) return undefined;
  return el.getAttribute(field);
}

// ═══════════════════════════════════════════════════════════════════════

describe("Awareness liminality: basic peer preview", () => {
  let docA: Y.Doc;
  let plexusA: TestPlexus<AwareEntity>;
  let rootA: AwareEntity;

  let docB: Y.Doc;
  let plexusB: TestPlexus<AwareEntity>;
  let rootB: AwareEntity;

  let shadowB: Y.Doc; // B's shadow doc for receiving A's liminal preview

  beforeEach(() => {
    // Client A
    const resultA = initTestPlexus(new AwareEntity({ width: "100px", height: "200px", color: "red" }));
    docA = resultA.doc;
    plexusA = resultA.plexus;
    rootA = resultA.root;

    // Client B — synced from A
    docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    plexusB = (plexusA.constructor as any).connect(docB);
    rootB = plexusB.root;

    // B's shadow doc — clone of B's main doc, receives A's liminal deltas
    shadowB = new Y.Doc({ gc: true });
    Y.applyUpdate(shadowB, Y.encodeStateAsUpdate(docB));

    expect(rootA.width).toBe("100px");
    expect(rootB.width).toBe("100px");
  });

  it("B sees A's liminal changes via shadow doc", () => {
    const mainSV = Y.encodeStateVector(docA);

    // A enters liminality and drags
    plexusA.enterLiminality();
    rootA.width = "300px";
    rootA.height = "400px";

    // A broadcasts delta via awareness
    const delta = broadcastLiminalDelta(plexusA, shadowB, mainSV);
    console.log(`Liminal delta: ${delta.byteLength} bytes`);

    // B reads from shadow — sees A's preview
    const previewWidth = readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width");
    const previewHeight = readFromShadow(shadowB, "AwareEntity", rootA.uuid, "height");
    expect(previewWidth).toBe("300px");
    expect(previewHeight).toBe("400px");

    // B's main doc is unchanged
    expect(rootB.width).toBe("100px");
    expect(rootB.height).toBe("200px");

    plexusA.revertLiminality();
  });

  it("A reverts — B's shadow is stale but B's main doc is clean", () => {
    const mainSV = Y.encodeStateVector(docA);

    plexusA.enterLiminality();
    rootA.width = "999px";

    broadcastLiminalDelta(plexusA, shadowB, mainSV);
    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width")).toBe("999px");

    // A reverts — no commit, no sync
    plexusA.revertLiminality();

    // B's main doc still has original value
    expect(rootB.width).toBe("100px");

    // B's shadow has stale liminal value — but awareness would clear it
    // In real code: A sets awareness.liminal = null → B destroys/rebuilds shadow
    // For this test: B rebuilds shadow from main doc
    const freshShadow = new Y.Doc({ gc: true });
    Y.applyUpdate(freshShadow, Y.encodeStateAsUpdate(docB));
    expect(readFromShadow(freshShadow, "AwareEntity", rootA.uuid, "width")).toBe("100px");
  });

  it("A commits — B sees committed value via normal sync", () => {
    plexusA.enterLiminality();
    for (let i = 0; i < 30; i++) {
      rootA.width = `${100 + i * 5}px`;
    }

    plexusA.commitLiminality();
    expect(rootA.width).toBe("245px");

    // Normal sync: A → B
    syncDocs(docA, docB);

    // B sees committed value on main doc
    expect(rootB.width).toBe("245px");
  });

  it("60-frame drag: shadow updates each frame, commit is clean", () => {
    const mainSV = Y.encodeStateVector(docA);

    plexusA.enterLiminality();

    // Simulate 60 frames with periodic awareness broadcasts
    for (let i = 0; i < 60; i++) {
      rootA.width = `${100 + i * 3}px`;

      // Broadcast every 6 frames (~10fps)
      if (i % 6 === 5) {
        broadcastLiminalDelta(plexusA, shadowB, mainSV);
        const preview = readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width");
        expect(preview).toBe(`${100 + i * 3}px`);
      }
    }

    // Commit
    plexusA.commitLiminality();
    syncDocs(docA, docB);
    expect(rootB.width).toBe("277px");

    // B's main doc has NO liminal clientIds
    const sv = Y.decodeStateVector(Y.encodeStateVector(docB));
    for (const [clientId] of sv) {
      // No liminal clientIds — genesis (above uint32) is fine
      expect(clientId < 0xff_ff_ff_ff + 1 || clientId > 2 * (0xff_ff_ff_ff + 1)).toBe(true);
    }
  });

  it("multiple fields: shadow shows all changes", () => {
    const mainSV = Y.encodeStateVector(docA);

    plexusA.enterLiminality();
    rootA.width = "300px";
    rootA.height = "400px";
    rootA.color = "blue";

    broadcastLiminalDelta(plexusA, shadowB, mainSV);

    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width")).toBe("300px");
    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "height")).toBe("400px");
    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "color")).toBe("blue");

    plexusA.revertLiminality();
  });

  it("commit after preview: shadow and main doc converge", () => {
    const mainSV = Y.encodeStateVector(docA);

    plexusA.enterLiminality();
    rootA.width = "500px";

    // B previews via shadow
    broadcastLiminalDelta(plexusA, shadowB, mainSV);
    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width")).toBe("500px");

    // A commits
    plexusA.commitLiminality();

    // Sync committed value to B's main doc
    syncDocs(docA, docB);
    expect(rootB.width).toBe("500px");

    // Also sync to B's shadow (it receives main doc updates)
    Y.applyUpdate(shadowB, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(shadowB)));

    // Shadow and main doc show the same value
    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width")).toBe("500px");
  });

  it("A and B both see correct state during concurrent editing", () => {
    const mainSV = Y.encodeStateVector(docA);

    // A enters liminality on width
    plexusA.enterLiminality();
    rootA.width = "300px";

    // Meanwhile B commits a normal change to color (not liminal)
    plexusB.transact(() => { rootB.color = "green"; });
    syncDocs(docA, docB);

    // A's liminal state
    expect(rootA.width).toBe("300px"); // liminal value
    expect(rootA.color).toBe("green"); // synced from B

    // B sees A's preview via shadow
    // First update shadow with B's latest state
    Y.applyUpdate(shadowB, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(shadowB)));
    broadcastLiminalDelta(plexusA, shadowB, mainSV);

    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "width")).toBe("300px");
    expect(readFromShadow(shadowB, "AwareEntity", rootA.uuid, "color")).toBe("green");

    plexusA.commitLiminality();
    syncDocs(docA, docB);

    expect(rootB.width).toBe("300px");
    expect(rootB.color).toBe("green");
  });

  it("rapid cycles: 10 drags, some commit, some revert", () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      const isCommit = cycle % 3 !== 2;

      plexusA.enterLiminality();
      rootA.width = `${100 + cycle * 50}px`;

      if (isCommit) {
        plexusA.commitLiminality();
        syncDocs(docA, docB);
      } else {
        plexusA.revertLiminality();
      }
    }

    // After 10 cycles (7 commits, 3 reverts), B has the last committed value
    expect(rootA.width).toBe(rootB.width);

    // Zero liminal artifacts on B (genesis clientIds are fine)
    const sv = Y.decodeStateVector(Y.encodeStateVector(docB));
    for (const [clientId] of sv) {
      expect(clientId < 0xff_ff_ff_ff + 1 || clientId > 2 * (0xff_ff_ff_ff + 1)).toBe(true);
    }
  });
});
