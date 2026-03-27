/**
 * Liminality Tests — validates the single-doc proxy store architecture.
 *
 * This is black magic surgery on Yjs internals:
 * - RoutedClientsMap replaces doc.store.clients
 * - Item.prototype.delete conditionally blocked on tracked fields
 * - Linked list stitching on commit/revert
 *
 * Every edge case must be validated.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { isLiminalClientId } from "../../genesis-client.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// ── Test Models ──

@syncing("LimEntity")
class LimEntity extends PlexusModel {
  @syncing accessor width: string = "100px";
  @syncing accessor height: string = "200px";
  @syncing accessor color: string = "red";
  @syncing accessor opacity: number = 1;
  @syncing.child accessor child: LimEntity | null = null;
}

// ── Helpers ──

let doc: Y.Doc;
let plexus: TestPlexus<LimEntity>;
let root: LimEntity;

function setup(init: Partial<{ width: string; height: string; color: string; opacity: number }> = {}) {
  const result = initTestPlexus(new LimEntity({ width: "100px", height: "200px", color: "red", opacity: 1, ...init }));
  doc = result.doc;
  plexus = result.plexus;
  root = result.root;
}

// ═══════════════════════════════════════════════════════════════════════

describe("Liminality: state transitions", () => {
  beforeEach(() => setup());

  it("isLiminal is false initially", () => {
    expect(plexus.isLiminal).toBe(false);
  });

  it("enterLiminality sets isLiminal to true", () => {
    plexus.enterLiminality();
    expect(plexus.isLiminal).toBe(true);
    plexus.revertLiminality();
  });

  it("commitLiminality sets isLiminal to false", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();
    expect(plexus.isLiminal).toBe(false);
  });

  it("revertLiminality sets isLiminal to false", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.revertLiminality();
    expect(plexus.isLiminal).toBe(false);
  });

  it("double enterLiminality is guarded (no throw, console.error)", () => {
    plexus.enterLiminality();
    // Should not throw — guard + console.error
    plexus.enterLiminality();
    expect(plexus.isLiminal).toBe(true);
    plexus.revertLiminality();
  });

  it("commitLiminality when not liminal is guarded", () => {
    // Should not throw
    plexus.commitLiminality();
    expect(plexus.isLiminal).toBe(false);
  });

  it("revertLiminality when not liminal is guarded", () => {
    plexus.revertLiminality();
    expect(plexus.isLiminal).toBe(false);
  });

  it("doc.clientID is unchanged during liminality (scratchpad approach)", () => {
    const regId = doc.clientID;
    plexus.enterLiminality();
    expect(doc.clientID).toBe(regId); // NOT swapped — writes go to scratchpad

    root.width = "300px";
    plexus.commitLiminality();
    expect(doc.clientID).toBe(regId);
  });
});

describe("Liminality: basic commit", () => {
  beforeEach(() => setup());

  it("single field commit preserves final value", () => {
    plexus.enterLiminality();
    root.width = "200px";
    root.width = "300px";
    plexus.commitLiminality();
    expect(root.width).toBe("300px");
  });

  it("multi-field commit preserves all final values", () => {
    plexus.enterLiminality();
    root.width = "300px";
    root.height = "400px";
    root.color = "blue";
    plexus.commitLiminality();
    expect(root.width).toBe("300px");
    expect(root.height).toBe("400px");
    expect(root.color).toBe("blue");
  });

  it("60-frame drag commits final value", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) {
      root.width = `${100 + i * 3}px`;
    }
    plexus.commitLiminality();
    expect(root.width).toBe("277px");
  });

  it("untouched fields are not affected by commit", () => {
    plexus.enterLiminality();
    root.width = "999px";
    plexus.commitLiminality();
    expect(root.height).toBe("200px"); // untouched
    expect(root.color).toBe("red");    // untouched
  });

  it("commit with no writes is a no-op", () => {
    plexus.enterLiminality();
    plexus.commitLiminality();
    expect(root.width).toBe("100px");
  });
});

describe("Liminality: basic revert", () => {
  beforeEach(() => setup());

  it("revert restores original value", () => {
    plexus.enterLiminality();
    root.width = "999px";
    expect(root.width).toBe("999px"); // liminal value visible during session
    plexus.revertLiminality();
    expect(root.width).toBe("100px"); // restored
  });

  it("revert after 60-frame drag restores original", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) {
      root.width = `${100 + i * 5}px`;
    }
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });

  it("revert restores multiple fields", () => {
    plexus.enterLiminality();
    root.width = "999px";
    root.height = "888px";
    root.color = "green";
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
    expect(root.height).toBe("200px");
    expect(root.color).toBe("red");
  });

  it("revert with no writes is a no-op", () => {
    plexus.enterLiminality();
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });
});

describe("Liminality: undo/redo after commit", () => {
  beforeEach(() => setup());

  it("undo after commit restores pre-liminal value", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();
    expect(root.width).toBe("300px");

    plexus.undo();
    expect(root.width).toBe("100px");
  });

  it("redo after undo restores committed value", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    plexus.undo();
    expect(root.width).toBe("100px");

    plexus.redo();
    expect(root.width).toBe("300px");
  });

  it("60-frame drag: commit → undo → redo roundtrip", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) root.width = `${100 + i * 3}px`;
    plexus.commitLiminality();

    const committed = root.width;
    plexus.undo();
    expect(root.width).toBe("100px");
    plexus.redo();
    expect(root.width).toBe(committed);
  });

  it("multi-field commit: undo restores all fields", () => {
    plexus.enterLiminality();
    root.width = "300px";
    root.height = "400px";
    plexus.commitLiminality();

    plexus.undo();
    expect(root.width).toBe("100px");
    expect(root.height).toBe("200px");
  });

  it("commit is isolated: doesn't merge with previous undo entry", () => {
    root.color = "blue"; // tracked write before liminality

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    // Undo the commit — should only revert width, not color
    plexus.undo();
    expect(root.width).toBe("100px");
    expect(root.color).toBe("blue"); // previous change survives

    // Undo again — reverts color
    plexus.undo();
    expect(root.color).toBe("red");
  });

  it("commit is isolated: doesn't merge with subsequent write", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    root.color = "blue"; // write after commit

    // Undo the color change
    plexus.undo();
    expect(root.color).toBe("red");
    expect(root.width).toBe("300px"); // commit survives

    // Undo the commit
    plexus.undo();
    expect(root.width).toBe("100px");
  });
});

describe("Liminality: undo during session", () => {
  beforeEach(() => setup());

  it("undo during liminality: reverts session then undoes previous", () => {
    root.color = "blue"; // committed change

    plexus.enterLiminality();
    root.width = "999px";

    // Undo while liminal — should revert liminality then undo "color = blue"
    plexus.undo();
    expect(plexus.isLiminal).toBe(false);
    expect(root.width).toBe("100px");  // reverted
    expect(root.color).toBe("red");    // undone
  });

  it("redo after undo-during-liminality works", () => {
    root.color = "blue";

    plexus.enterLiminality();
    root.width = "999px";
    plexus.undo(); // revert + undo

    plexus.redo();
    expect(root.color).toBe("blue");
  });
});

describe("Liminality: reactivity", () => {
  beforeEach(() => setup());

  it("liminal writes are visible during session (backingStorage updates)", () => {
    plexus.enterLiminality();
    root.width = "200px";
    expect(root.width).toBe("200px"); // visible during session
    root.width = "300px";
    expect(root.width).toBe("300px"); // each frame visible
    plexus.revertLiminality();
    expect(root.width).toBe("100px"); // reverted
  });

  it("revert restores value — verifiable by reading entity", () => {
    plexus.enterLiminality();
    root.width = "999px";
    expect(root.width).toBe("999px");

    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });

  it("committed value syncs to peer via Yjs observation", () => {
    const peer = new Y.Doc({ guid: doc.guid });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const plexus2 = (plexus.constructor as any).connect(peer);
    const root2 = plexus2.root;

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    // Sync committed value to peer
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));

    // Peer sees committed value (observation handler updated backingStorage)
    expect(root2.width).toBe("300px");

    peer.destroy();
  });
});

describe("Liminality: scratchpad doc", () => {
  beforeEach(() => setup());

  it("scratchpad is created on enter, destroyed on commit", () => {
    expect(plexus.__liminalSession__).toBeNull();

    plexus.enterLiminality();
    expect(plexus.__liminalSession__).not.toBeNull();
    expect(plexus.__liminalSession__!.scratchDoc).toBeDefined();

    root.width = "300px";
    plexus.commitLiminality();
    expect(plexus.__liminalSession__).toBeNull();
  });

  it("scratchpad is destroyed on revert", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.revertLiminality();
    expect(plexus.__liminalSession__).toBeNull();
  });

  it("main doc clientID is unchanged during liminality", () => {
    const regId = doc.clientID;
    plexus.enterLiminality();
    expect(doc.clientID).toBe(regId); // NOT swapped
    root.width = "300px";
    plexus.commitLiminality();
    expect(doc.clientID).toBe(regId); // still the same
  });

  it("main doc has zero liminal Items after commit", () => {
    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    // Main doc's state vector only has the regular clientId
    const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [clientId] of sv) {
      expect(isLiminalClientId(clientId)).toBe(false);
    }
  });

  it("Item.prototype.delete is NOT patched (no surgery)", () => {
    const origDelete = (Y.Item.prototype as any).delete;

    plexus.enterLiminality();
    root.width = "300px";
    expect((Y.Item.prototype as any).delete).toBe(origDelete); // unchanged!

    plexus.commitLiminality();
    expect((Y.Item.prototype as any).delete).toBe(origDelete);
  });
});

describe("Liminality: peer sync", () => {
  beforeEach(() => setup());

  it("normal Yjs sync during liminality excludes liminal Items", () => {
    // Create a peer and sync baseline
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

    plexus.enterLiminality();
    root.width = "999px";

    // Sync delta to peer
    const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer));
    Y.applyUpdate(peer, delta);

    // Peer should NOT see the liminal value
    // (RoutedClientsMap hides it from encodeStateAsUpdate)
    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("LimEntity")?.values().next().value;
    expect(peerEl?.getAttribute("width")).toBe("100px"); // unchanged

    plexus.revertLiminality();
  });

  it("committed value syncs normally to peer", () => {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    // Sync committed delta
    const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer));
    Y.applyUpdate(peer, delta);

    const peerTypes = peer.getMap("types") as Y.Map<Y.Map<Y.XmlElement>>;
    const peerEl = peerTypes.get("LimEntity")?.values().next().value;
    expect(peerEl?.getAttribute("width")).toBe("300px");
  });
});

describe("Liminality: rapid cycles", () => {
  beforeEach(() => setup());

  it("10 commit cycles with full undo/redo", () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      plexus.enterLiminality();
      for (let f = 0; f < 10; f++) {
        root.width = `${100 + cycle * 50 + f * 5}px`;
      }
      plexus.commitLiminality();
    }

    expect(root.width).toBe("595px"); // last frame of last cycle

    // Undo all 10 commits
    for (let i = 0; i < 10; i++) plexus.undo();
    expect(root.width).toBe("100px"); // initial

    // Redo all
    for (let i = 0; i < 10; i++) plexus.redo();
    expect(root.width).toBe("595px");
  });

  it("mixed commit/revert cycles", () => {
    plexus.enterLiminality();
    root.width = "200px";
    plexus.commitLiminality();

    plexus.enterLiminality();
    root.width = "999px";
    plexus.revertLiminality(); // revert — width back to "200px"
    expect(root.width).toBe("200px");

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    expect(root.width).toBe("300px");

    // Undo: 300px → 200px
    plexus.undo();
    expect(root.width).toBe("200px");

    // Undo: 200px → 100px
    plexus.undo();
    expect(root.width).toBe("100px");

    // Redo both
    plexus.redo();
    plexus.redo();
    expect(root.width).toBe("300px");
  });

  it("5 cycles with multi-field drag", () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      plexus.enterLiminality();
      for (let f = 0; f < 20; f++) {
        root.width = `${100 + f * 10}px`;
        root.height = `${200 + f * 5}px`;
      }
      plexus.commitLiminality();
    }

    // Undo all 5
    for (let i = 0; i < 5; i++) plexus.undo();
    expect(root.width).toBe("100px");
    expect(root.height).toBe("200px");

    // Redo all 5
    for (let i = 0; i < 5; i++) plexus.redo();
    expect(root.width).toBe("290px");
    expect(root.height).toBe("295px");
  });
});

describe("Liminality: numeric values", () => {
  beforeEach(() => setup());

  it("number fields work during liminality", () => {
    plexus.enterLiminality();
    root.opacity = 0.5;
    plexus.commitLiminality();
    expect(root.opacity).toBe(0.5);

    plexus.undo();
    expect(root.opacity).toBe(1);

    plexus.redo();
    expect(root.opacity).toBe(0.5);
  });

  it("60-frame opacity scrub", () => {
    plexus.enterLiminality();
    for (let i = 0; i < 60; i++) {
      root.opacity = i / 59;
    }
    plexus.commitLiminality();
    expect(root.opacity).toBeCloseTo(1);

    plexus.undo();
    expect(root.opacity).toBe(1); // initial
  });
});

describe("Liminality: edge cases", () => {
  beforeEach(() => setup());

  it("writing same value during liminality is a no-op (early return in setter)", () => {
    plexus.enterLiminality();
    root.width = "100px"; // same as current — setter early-returns
    plexus.commitLiminality();
    expect(root.width).toBe("100px");
  });

  it("null value during liminality", () => {
    const child = new LimEntity({ width: "50px" });
    plexus.transact(() => { root.child = child; });

    plexus.enterLiminality();
    root.width = "300px";
    plexus.commitLiminality();

    expect(root.width).toBe("300px");
    expect(root.child).toBe(child); // untouched
  });

  it("rapid enter/revert with no writes", () => {
    for (let i = 0; i < 100; i++) {
      plexus.enterLiminality();
      plexus.revertLiminality();
    }
    expect(root.width).toBe("100px");
    expect(plexus.isLiminal).toBe(false);
  });

  it("revert after modifying then reverting to same value", () => {
    plexus.enterLiminality();
    root.width = "999px";
    root.width = "100px"; // back to original
    plexus.revertLiminality();
    expect(root.width).toBe("100px");
  });
});
