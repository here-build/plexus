/**
 * Liminal entity references in awareness — the revert edge case.
 *
 * A liminal session's entities never reach prime (the forwarder holds LIMINAL
 * origins), but they ARE representable in awareness: the preview transport
 * carries the session delta to every peer's shadow, so the membrane's vouch for
 * a liminal reference is family membership on the AUTHORING plane, and the
 * reader resolves there too.
 *
 * A liminal reference can legally die — the session reverts and the entity is
 * gone forever. Ruling (docs/awareness-coherence.md): liminal-kind refs are
 * never parked by the coherence gate (there is no future doc state to wait
 * for); the read yields the live instance while the session lives or after
 * commit (bound-first probe), and NULL after revert; revertLiminality emits an
 * explicit console warning when awareness still references reverted entities.
 *
 * Born red against: write-half membership checked on prime (throws mid-session),
 * reads resolving on prime (never see session entities), no null-on-dead, no
 * revert warning.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { applyAwarenessUpdate, encodeAwarenessUpdate } from "../../awareness.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("LimRefItem")
class LimRefItem extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("LimRefHost")
class LimRefHost extends PlexusModel {
  @syncing.child.list accessor items: LimRefItem[] = [];
}

function sessionEntity(root: LimRefHost): LimRefItem {
  const entity = new LimRefItem({ name: "tentative" });
  root.items.push(entity);
  return entity;
}

describe("liminal entity refs in awareness", () => {
  it("publishing a session entity in awareness does not throw (vouch is the authoring plane)", () => {
    const { plexus, root } = initTestPlexus(new LimRefHost());
    plexus.enterLiminality();
    const entity = sessionEntity(root);
    expect(entity.uuid[0]).toBe("l");

    expect(() => plexus.awareness.setField("ref", entity as never)).not.toThrow();
    plexus.revertLiminality();
  });

  it("while the session lives, the read resolves to the live instance", () => {
    const { plexus, root } = initTestPlexus(new LimRefHost());
    plexus.enterLiminality();
    const entity = sessionEntity(root);

    plexus.awareness.setField("ref", entity as never);
    expect(plexus.awareness.getField("ref")).toBe(entity);
    plexus.revertLiminality();
  });

  it("after commit, the reference still resolves (bound-first probe)", () => {
    const { plexus, root } = initTestPlexus(new LimRefHost());
    plexus.enterLiminality();
    const entity = sessionEntity(root);
    const uuid = entity.uuid;
    plexus.awareness.setField("ref", entity as never);
    plexus.commitLiminality();

    const read = plexus.awareness.getField("ref") as LimRefItem | null;
    expect(read).toBeInstanceOf(LimRefItem);
    expect(read!.uuid).toBe(uuid);
    expect(read!.name).toBe("tentative");
  });

  it("after revert, the field reads null — the entity is gone forever, not 'not yet'", () => {
    const { plexus, root } = initTestPlexus(new LimRefHost());
    plexus.enterLiminality();
    const entity = sessionEntity(root);
    plexus.awareness.setField("ref", entity as never);
    plexus.revertLiminality();

    expect(plexus.awareness.getField("ref")).toBe(null);
  });

  it("revertLiminality warns when awareness still references reverted entities", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { plexus, root } = initTestPlexus(new LimRefHost());
      plexus.enterLiminality();
      const entity = sessionEntity(root);
      plexus.awareness.setField("ref", entity as never);
      plexus.revertLiminality();

      expect(warn.mock.calls.some(([first]) => String(first).includes("liminal"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a peer resolves a liminal ref through the preview transport, to ITS family instance", () => {
    const { doc: docA, plexus: pA, root: rootA } = initTestPlexus(new LimRefHost());
    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { plexus: pB, root: rootB } = connectTestPlexus<LimRefHost>(docB);

    pA.enterLiminality();
    const entity = sessionEntity(rootA);
    pA.broadcastLiminalPreview();
    pA.awareness.setField("ref", entity as never);

    // One relay carries both the preview delta and the reference frame; B's
    // auto-preview processing applies the delta into B's shadow on the change.
    const update = encodeAwarenessUpdate(pA.awareness, [...pA.awareness.states.keys()]);
    applyAwarenessUpdate(pB.awareness, update, "remote");

    const read = (pB.awareness.getPeer(pA.awareness.clientID) as { ref?: LimRefItem })?.ref;
    expect(read).toBeInstanceOf(LimRefItem);
    expect(read!.uuid).toBe(entity.uuid);
    expect(read!.name).toBe("tentative");
    // Stable family-plane identity: repeated reads hand back the same instance.
    const again = (pB.awareness.getPeer(pA.awareness.clientID) as { ref?: LimRefItem })?.ref;
    expect(again).toBe(read);
    // OPEN (liminality feature, not serde): B's model TREE does not yet repaint
    // previewed structural child-adds — `rootB.items` stays empty although the
    // entity is live in B's shadow. Scalar previews repaint (peer-preview.test);
    // structural preview paint is unbuilt. Tracked outside this suite.
    void rootB;
    pA.revertLiminality();
  });
});
