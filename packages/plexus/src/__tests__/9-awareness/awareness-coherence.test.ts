/**
 * Awareness Coherence — the read-half gate (docs/awareness-coherence.md).
 *
 * A frame whose entity refs the local doc cannot resolve yet is parked, not
 * applied; it releases through the normal change path when the doc catches up.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyAwarenessUpdate, encodeAwarenessUpdate, PlexusAwareness, removeAwarenessStates } from "../../awareness.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("CoherenceEntity")
class CoherenceEntity extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("CoherenceHost")
class CoherenceHost extends PlexusModel {
  @syncing.child.list accessor items: CoherenceEntity[] = [];
}

/** Origin doc A + replica doc B synced only up to the base snapshot; deltas after that are captured for manual catch-up. */
function twoDocHarness() {
  const { doc: docA, plexus: pA, root: rootA } = initTestPlexus(new CoherenceHost());
  const base = Y.encodeStateAsUpdate(docA);

  const deltas: Uint8Array[] = [];
  docA.on("update", (u: Uint8Array) => deltas.push(u));

  const docB = new Y.Doc({ guid: docA.guid });
  Y.applyUpdate(docB, base);
  const { plexus: pB } = connectTestPlexus<CoherenceHost>(docB);

  const awA = pA.awareness;
  const awB = pB.awareness;

  const relay = (): void => {
    const update = encodeAwarenessUpdate(awA, [...awA.states.keys()]);
    applyAwarenessUpdate(awB, update, "remote");
  };
  const catchUp = (): void => {
    for (const u of deltas.splice(0)) Y.applyUpdate(docB, u);
  };

  return { rootA, awA, awB, docB, relay, catchUp };
}

const refChannel = (aw: PlexusAwareness): number => PlexusAwareness.channelId(aw.clientID, 1);

describe("awareness coherence gate", () => {
  it("a frame referencing a present entity applies immediately", () => {
    const { rootA, awA, awB, relay, catchUp } = twoDocHarness();
    const entity = new CoherenceEntity({ name: "here" });
    rootA.items.push(entity);
    catchUp(); // B has the entity before the frame arrives

    awA.setField("ref", entity as never);
    relay();

    const peer = awB.getPeer(awA.clientID) as { ref?: CoherenceEntity };
    expect(peer?.ref).toBeInstanceOf(CoherenceEntity);
    expect(peer!.ref!.uuid).toBe(entity.uuid);
  });

  it("plain frames are never gated", () => {
    const { awA, awB, relay } = twoDocHarness();
    awA.setField("note", { plain: true } as never);
    relay();
    expect((awB.getPeer(awA.clientID) as { note?: unknown })?.note).toEqual({ plain: true });
  });

  it("a frame referencing an absent entity parks, then releases on doc catch-up via the normal change path", () => {
    const { rootA, awA, awB, relay, catchUp } = twoDocHarness();
    const entity = new CoherenceEntity({ name: "late" });
    rootA.items.push(entity);
    // Frame first, doc later — the fresh-join race.
    awA.setField("ref", entity as never);
    relay();

    // Schema (channel 0) applied — membership visible; ref channel parked.
    expect(awB.states.has(awA.clientID)).toBe(true);
    expect(awB.states.has(refChannel(awA))).toBe(false);
    expect((awB.getRawPeer(awA.clientID) ?? {}).ref).toBeUndefined();

    let changes = 0;
    const onChange = (): void => {
      changes += 1;
    };
    awB.on("change", onChange);

    catchUp();

    expect(changes).toBe(1);
    expect(awB.states.has(refChannel(awA))).toBe(true);
    const peer = awB.getPeer(awA.clientID) as { ref?: CoherenceEntity };
    expect(peer?.ref).toBeInstanceOf(CoherenceEntity);
    expect(peer!.ref!.uuid).toBe(entity.uuid);
    awB.off("change", onChange);
  });

  it("newest parked frame wins — an older incoherent frame never applies", () => {
    const { rootA, awA, awB, relay, catchUp } = twoDocHarness();
    const first = new CoherenceEntity({ name: "v1" });
    rootA.items.push(first);
    awA.setField("ref", first as never);
    relay(); // parks clock N

    const second = new CoherenceEntity({ name: "v2" });
    rootA.items.push(second);
    awA.setField("ref", second as never);
    relay(); // parks clock N+1, supersedes

    catchUp();
    const peer = awB.getPeer(awA.clientID) as { ref?: CoherenceEntity };
    expect(peer!.ref!.uuid).toBe(second.uuid);
  });

  it("a newer coherent frame supersedes a parked one; the parked frame never resurrects", () => {
    const { rootA, awA, awB, relay, catchUp } = twoDocHarness();
    const entity = new CoherenceEntity({ name: "gone" });
    rootA.items.push(entity);
    awA.setField("ref", entity as never);
    relay(); // parks

    awA.setField("ref", { plain: "coherent" } as never);
    relay(); // coherent, newer clock — applies and drops the parked frame

    expect((awB.getPeer(awA.clientID) as { ref?: unknown }).ref).toEqual({ plain: "coherent" });

    catchUp(); // doc catches up — parked frame must NOT come back
    expect((awB.getPeer(awA.clientID) as { ref?: unknown }).ref).toEqual({ plain: "coherent" });
  });

  it("explicit removal clears parked frames for the base", () => {
    const { rootA, awA, awB, relay, catchUp } = twoDocHarness();
    const entity = new CoherenceEntity({ name: "reaped" });
    rootA.items.push(entity);
    awA.setField("ref", entity as never);
    relay(); // parks

    removeAwarenessStates(awB, [awA.clientID], "test");
    catchUp(); // must not resurrect the removed peer's parked channel
    expect(awB.states.has(refChannel(awA))).toBe(false);
  });
});
