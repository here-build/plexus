/**
 * ReactiveAwareness — v0: reactive present clientId list.
 */

import { autorun } from "mobx";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  PlexusAwareness,
  removeAwarenessStates,
} from "@here.build/plexus";

import { ReactiveAwareness } from "../index.js";

describe("ReactiveAwareness.clientIds", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  function makeAwareness(): PlexusAwareness {
    const doc = new Y.Doc();
    docs.push(doc);
    return new PlexusAwareness(doc);
  }

  it("lists local base after construction (channel 0 present)", () => {
    const aw = makeAwareness();
    expect(new ReactiveAwareness(aw).clientIds).toEqual([aw.clientID]);
  });

  it("includes secondary local clients on a shared hub", () => {
    const hub = makeAwareness();
    const pen = PlexusAwareness.createLocalClient(hub);
    expect(new ReactiveAwareness(hub).clientIds).toEqual([hub.clientID, pen.clientID].sort((a, b) => a - b));
  });

  it("autorun re-fires when a peer appears via wire", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docs.push(docA, docB);
    const awA = new PlexusAwareness(docA);
    const awB = new PlexusAwareness(docB);
    const lens = new ReactiveAwareness(awA);

    const seen: number[][] = [];
    const stop = autorun(() => {
      seen.push([...lens.clientIds]);
    });

    expect(seen.at(-1)).toEqual([awA.clientID]);

    awB.setField("role" as never, "kernel" as never);
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");

    expect(lens.clientIds).toContain(awA.clientID);
    expect(lens.clientIds).toContain(awB.clientID);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toEqual([awA.clientID, awB.clientID].sort((a, b) => a - b));

    stop();
  });

  it("drops clientIds when peer awareness is removed", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docs.push(docA, docB);
    const awA = new PlexusAwareness(docA);
    const awB = new PlexusAwareness(docB);
    const lens = new ReactiveAwareness(awA);

    awB.setField("role" as never, "kernel" as never);
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");
    expect(lens.clientIds).toContain(awB.clientID);

    removeAwarenessStates(awA, [awB.clientID], "remote");
    expect(lens.clientIds).toEqual([awA.clientID]);
  });
});

describe("ReactiveAwareness.clients", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  it("ComputedMap returns a stable ReactiveClientAwareness per clientId", () => {
    const doc = new Y.Doc();
    docs.push(doc);
    const aw = new PlexusAwareness(doc);
    const lens = new ReactiveAwareness(aw);
    const a = lens.clients.get(aw.clientID);
    const b = lens.clients.get(aw.clientID);
    expect(a).toBe(b);
    expect(a.clientId).toBe(aw.clientID);
    expect(a.present).toBe(true);
  });

  it("client.present tracks remove without re-firing an unrelated peer", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const docC = new Y.Doc();
    docs.push(docA, docB, docC);
    const awA = new PlexusAwareness(docA);
    const awB = new PlexusAwareness(docB);
    const awC = new PlexusAwareness(docC);
    const lens = new ReactiveAwareness(awA);

    for (const peer of [awB, awC]) {
      peer.setField("role" as never, "kernel" as never);
      applyAwarenessUpdate(awA, encodeAwarenessUpdate(peer, [...peer.states.keys()]), "remote");
    }

    const clientB = lens.clients.get(awB.clientID);
    const clientC = lens.clients.get(awC.clientID);
    expect(clientB.present).toBe(true);
    expect(clientC.present).toBe(true);

    let bFires = 0;
    let cFires = 0;
    const stopB = autorun(() => {
      void clientB.present;
      bFires += 1;
    });
    const stopC = autorun(() => {
      void clientC.present;
      cFires += 1;
    });
    const b0 = bFires;
    const c0 = cFires;

    removeAwarenessStates(awA, [awB.clientID], "remote");
    expect(clientB.present).toBe(false);
    expect(bFires).toBeGreaterThan(b0);
    // C only observed present; remove of B must not re-fire C.
    expect(cFires).toBe(c0);
    expect(clientC.present).toBe(true);

    stopB();
    stopC();
  });
});

describe("ReactiveClientAwareness fields", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  it("tracks field existence and values on a local client", () => {
    const doc = new Y.Doc();
    docs.push(doc);
    const aw = new PlexusAwareness(doc);
    const lens = new ReactiveAwareness(aw);
    const client = lens.clients.get(aw.clientID);

    expect(client.fields).toEqual([]);
    expect(client.hasField("role")).toBe(false);
    expect(client.field("role")).toBeUndefined();

    aw.setField("role" as never, "kernel" as never);
    expect(client.hasField("role")).toBe(true);
    expect(client.fields).toContain("role");
    expect(client.field("role")).toBe("kernel");
  });

  it("field value autorun does not re-fire on a different field of the same client", () => {
    const doc = new Y.Doc();
    docs.push(doc);
    const aw = new PlexusAwareness(doc);
    const client = new ReactiveAwareness(aw).clients.get(aw.clientID);

    aw.setField("role" as never, "kernel" as never);
    aw.setField("report" as never, { n: 1 } as never);

    let roleFires = 0;
    const stop = autorun(() => {
      void client.field("role");
      roleFires += 1;
    });
    const baseline = roleFires;

    aw.setField("report" as never, { n: 2 } as never);
    expect(client.field("report")).toEqual({ n: 2 });
    expect(roleFires).toBe(baseline);

    aw.setField("role" as never, "catalog" as never);
    expect(roleFires).toBeGreaterThan(baseline);
    stop();
  });

  it("byField aggregates the same values as client.field", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docs.push(docA, docB);
    const awA = new PlexusAwareness(docA);
    const awB = new PlexusAwareness(docB);
    const lens = new ReactiveAwareness(awA);

    awA.setField("role" as never, "self" as never);
    awB.setField("role" as never, "kernel" as never);
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");

    const byRole = lens.byField.get("role");
    expect(byRole.get(awA.clientID)).toBe("self");
    expect(byRole.get(awB.clientID)).toBe("kernel");
    expect(lens.clients.get(awB.clientID).field("role")).toBe("kernel");
  });

  it("byField autorun tracks a peer field update", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docs.push(docA, docB);
    const awA = new PlexusAwareness(docA);
    const awB = new PlexusAwareness(docB);
    const lens = new ReactiveAwareness(awA);

    awB.setField("report" as never, { n: 1 } as never);
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");

    const seen: unknown[] = [];
    const stop = autorun(() => {
      seen.push(lens.byField.get("report").get(awB.clientID));
    });
    expect(seen.at(-1)).toEqual({ n: 1 });

    awB.setField("report" as never, { n: 2 } as never);
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");
    expect(seen.at(-1)).toEqual({ n: 2 });
    expect(seen.length).toBeGreaterThan(1);
    stop();
  });
});

describe("register installs aw.reactive", () => {
  it("prototype getter is one lens per instance", async () => {
    const { reactive } = await import("../register.js");
    const doc = new Y.Doc();
    const aw = new PlexusAwareness(doc);
    expect(aw.reactive).toBe(reactive(aw));
    expect(aw.reactive).toBe(aw.reactive);
    expect(aw.reactive.clientIds).toEqual([aw.clientID]);
    doc.destroy();
  });
});
