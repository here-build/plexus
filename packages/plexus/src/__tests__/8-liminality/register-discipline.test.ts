/**
 * Register discipline — the clientId partition scheme of the liminal-state
 * paper (docs/thinking/papers/plexus/liminal-state.md §A.3-A.5), grounded into
 * the shadow-primary implementation.
 *
 * The algebra: clientId ranges ARE the lifecycle stages. Regular `[0, 2^51)`
 * carries normal operations (p/b uuids); liminal `[2^51, 2^52)` carries
 * tentative session operations (l uuids); committed-ephemeral `[2^52, 3×2^51)`
 * carries promoted commits (never encoded as uuids — resolved via the original
 * l uuid's bound-first probe). ClientId gives precedence order; commutativity
 * gives safe delta add/subtract; the register bit is what makes a uuid's
 * lifecycle stage READABLE from the uuid alone.
 *
 * Discipline under shadow-primary (the efficiency grounding of the paper's
 * session-scoped shadow): the shadow doc RESTS at an independent regular-range
 * id — independent because Yjs rerolls a doc whose own clientID is advanced by
 * a non-local transaction, so prime's id cannot be shared (two-doc.test.ts
 * REJECTED APPROACHES) — and only a liminal session moves it into the liminal
 * register; commit/revert restore the resting id. A.5 invariant 4: setup and
 * steady-state operations use the regular clientId.
 *
 * These tests assert the INTENDED discipline. They were born red against the
 * post-migration state where the shadow was permanently parked in the liminal
 * register and every entity minted `l` (see ce3f8ef272 — the session-scratch
 * shadow became the always-authoring surface without shedding its session id).
 */

import { describe, expect, it } from "vitest";
import type * as Y from "yjs";

import { decode } from "../../crdt-uuid.js";
import { syncing } from "../../decorators.js";
import { isLiminalClientId, isRegularClientId } from "../../genesis-client.js";
import type { Plexus } from "../../Plexus.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { PlexusUUID } from "../../proxy-runtime-types.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("RegItem")
class RegItem extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("RegHost")
class RegHost extends PlexusModel {
  @syncing.child.list accessor items: RegItem[] = [];
}

function shadowDoc(plexus: Plexus<RegHost>): Y.Doc {
  return (plexus as unknown as { readonly __liminalDocument__: Y.Doc }).__liminalDocument__;
}

describe("register discipline: resting state", () => {
  it("the shadow RESTS in the regular register (A.5 invariant 4)", () => {
    const { plexus } = initTestPlexus(new RegHost());
    expect(isRegularClientId(shadowDoc(plexus).clientID)).toBe(true);
  });

  it("the shadow's resting id is independent of prime's (Yjs rerolls shared ids)", () => {
    const { doc, plexus } = initTestPlexus(new RegHost());
    expect(shadowDoc(plexus).clientID).not.toBe(doc.clientID);
  });

  it("steady-state entities mint p-prefixed uuids under the shadow's regular id", () => {
    const { doc, plexus, root } = initTestPlexus(new RegHost());
    const entity = new RegItem({ name: "steady" });
    root.items.push(entity);

    expect(entity.uuid[0]).toBe("p");
    const { clientId } = decode(entity.uuid as PlexusUUID);
    expect(clientId).toBe(shadowDoc(plexus).clientID);
    // Separation of identity planes: the struct author id is the shadow's
    // regular id, never the prime doc's id (which is the awareness identity).
    expect(clientId).not.toBe(doc.clientID);
  });
});

describe("register discipline: session switch and restore", () => {
  it("enterLiminality SWITCHES into the liminal register; in-session entities mint l", () => {
    const { plexus, root } = initTestPlexus(new RegHost());
    const resting = shadowDoc(plexus).clientID;

    plexus.enterLiminality();
    expect(isLiminalClientId(shadowDoc(plexus).clientID)).toBe(true);

    const tentative = new RegItem({ name: "tentative" });
    root.items.push(tentative);
    expect(tentative.uuid[0]).toBe("l");

    plexus.revertLiminality();
    expect(shadowDoc(plexus).clientID).toBe(resting);
  });

  it("commit restores the resting regular id; post-commit entities mint p again", () => {
    const { plexus, root } = initTestPlexus(new RegHost());
    const resting = shadowDoc(plexus).clientID;

    plexus.enterLiminality();
    root.items.push(new RegItem({ name: "in-session" }));
    plexus.commitLiminality();

    expect(shadowDoc(plexus).clientID).toBe(resting);

    const after = new RegItem({ name: "after" });
    root.items.push(after);
    expect(after.uuid[0]).toBe("p");
  });

  it("session ids are strictly increasing across sessions (paper invariant 1)", () => {
    const { plexus } = initTestPlexus(new RegHost());

    plexus.enterLiminality();
    const first = shadowDoc(plexus).clientID;
    plexus.revertLiminality();

    plexus.enterLiminality();
    const second = shadowDoc(plexus).clientID;
    plexus.revertLiminality();

    expect(isLiminalClientId(first)).toBe(true);
    expect(isLiminalClientId(second)).toBe(true);
    expect(second).toBeGreaterThan(first);
  });

  it("a committed session's entities keep their l uuids and still resolve (bound-first probe)", () => {
    const { plexus, root } = initTestPlexus(new RegHost());

    plexus.enterLiminality();
    const tentative = new RegItem({ name: "kept" });
    root.items.push(tentative);
    const uuid = tentative.uuid;
    expect(uuid[0]).toBe("l");
    plexus.commitLiminality();

    // Post-commit the struct lives in the committed-ephemeral register; the
    // original l uuid remains its address via the bound-first fallback.
    expect(root.items.some((item) => item.uuid === uuid)).toBe(true);
    expect(root.items.find((item) => item.uuid === uuid)?.name).toBe("kept");
  });
});
