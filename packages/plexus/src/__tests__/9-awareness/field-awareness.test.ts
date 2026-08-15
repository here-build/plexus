/**
 * FieldAwareness — per-field lens: isolation, freeze, heartbeat.
 */

import { autorun } from "mobx";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  FieldAwareness,
  PlexusAwareness,
  type AwarenessShape,
} from "../../index.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("FaItem")
class FaItem extends PlexusModel {
  @syncing accessor name: string = "";
}

@syncing("FaHost")
class FaHost extends PlexusModel {
  @syncing.child.list accessor items: FaItem[] = [];
}

describe("FieldAwareness", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const d of docs) d.destroy();
    docs.length = 0;
  });

  function make<S extends AwarenessShape>(): PlexusAwareness<S> {
    const doc = new Y.Doc();
    docs.push(doc);
    return new PlexusAwareness<S>(doc);
  }

  it("get / set / clear: undefined → value → null", () => {
    const aw = make<{ role: string }>();
    const role = new FieldAwareness(aw, "role");
    expect(role.get()).toBeUndefined();
    role.set("kernel");
    expect(role.get()).toBe("kernel");
    role.clear();
    expect(role.get()).toBeNull();
  });

  it("getOther reads self and a wired peer; getOthers excludes me", () => {
    const awA = make<{ role: string }>();
    const awB = make<{ role: string }>();
    const role = new FieldAwareness(awA, "role");
    role.set("self");
    awB.setField("role", "kernel");
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");

    expect(role.getOther(awA.clientID)).toBe("self");
    expect(role.getOther(awB.clientID)).toBe("kernel");
    expect(role.getOthers().get(awB.clientID)).toBe("kernel");
    expect(role.getOthers().has(awA.clientID)).toBe(false);
  });

  it("clientIds includes bases that have the field, not merely present ones", () => {
    const awA = make<{ role: string; extra: string }>();
    const awB = make<{ role: string; extra: string }>();
    const role = new FieldAwareness(awA, "role");
    awA.setField("extra", "only");
    awB.setField("role", "kernel");
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");

    expect(role.clientIds).toEqual([awB.clientID]);
    expect(new FieldAwareness(awA, "extra").clientIds).toEqual([awA.clientID]);
  });

  it("getOther autorun does not fire on a different field or client", () => {
    const aw = make<{ role: string; report: { n: number } }>();
    const role = new FieldAwareness(aw, "role");
    const report = new FieldAwareness(aw, "report");
    role.set("kernel");
    report.set({ n: 1 });

    let fires = 0;
    const stop = autorun(() => {
      void role.get();
      fires += 1;
    });
    const baseline = fires;

    report.set({ n: 2 });
    expect(fires).toBe(baseline);

    role.set("catalog");
    expect(fires).toBeGreaterThan(baseline);
    stop();
  });

  it("clientIds autorun fires on join / first set / leave, not on a value change", () => {
    const awA = make<{ role: string }>();
    const awB = make<{ role: string }>();
    const role = new FieldAwareness(awA, "role");

    let fires = 0;
    const stop = autorun(() => {
      void role.clientIds;
      fires += 1;
    });
    const afterConstruct = fires;

    role.set("self");
    expect(fires).toBeGreaterThan(afterConstruct);
    const afterSelf = fires;

    role.set("still-self");
    expect(fires).toBe(afterSelf);

    awB.setField("role", "kernel");
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");
    expect(fires).toBeGreaterThan(afterSelf);
    const afterJoin = fires;

    awB.setField("role", "catalog");
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");
    expect(fires).toBe(afterJoin);
    stop();
  });

  it("peer write is visible on a local lens", () => {
    const awA = make<{ report: { n: number } }>();
    const awB = make<{ report: { n: number } }>();
    const report = new FieldAwareness(awA, "report");

    const seen: unknown[] = [];
    const stop = autorun(() => {
      seen.push(report.getOther(awB.clientID));
    });
    expect(seen.at(-1)).toBeUndefined();

    awB.setField("report", { n: 1 });
    applyAwarenessUpdate(awA, encodeAwarenessUpdate(awB, [...awB.states.keys()]), "remote");
    expect(seen.at(-1)).toEqual({ n: 1 });
    stop();
  });

  it("clock-only channel-0 rewrite does not wake clientIds", () => {
    const aw = make<{ role: string }>();
    const role = new FieldAwareness(aw, "role");
    role.set("kernel");

    let fires = 0;
    const stop = autorun(() => {
      void role.clientIds;
      fires += 1;
    });
    const baseline = fires;

    const meta = aw.meta.get(aw.clientID);
    aw.meta.set(aw.clientID, { clock: (meta?.clock ?? 0) + 1, lastUpdated: Date.now() });
    applyAwarenessUpdate(aw, encodeAwarenessUpdate(aw, [aw.clientID]), "remote");

    expect(fires).toBe(baseline);
    expect(role.get()).toBe("kernel");
    stop();
  });

  it("returned objects are frozen; nested plains frozen; PlexusModel stays live", () => {
    const { plexus, root } = initTestPlexus(new FaHost());
    docs.push(plexus.doc);
    const entity = new FaItem({ name: "live" });
    root.items.push(entity);

    type Shape = { cursor: { x: number; nest: { y: number } }; ref: FaItem };
    const cursor = new FieldAwareness(plexus.awareness as PlexusAwareness<Shape>, "cursor");
    const ref = new FieldAwareness(plexus.awareness as PlexusAwareness<Shape>, "ref");

    cursor.set({ x: 1, nest: { y: 2 } });
    const got = cursor.get();
    expect(got).toEqual({ x: 1, nest: { y: 2 } });
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got!.nest)).toBe(true);
    expect(() => {
      (got as { x: number }).x = 9;
    }).toThrow();

    ref.set(entity);
    const live = ref.get();
    expect(live).toBe(entity);
    expect(Object.isFrozen(live)).toBe(false);
    live!.name = "renamed";
    expect(root.items[0]!.name).toBe("renamed");
  });

  it("two lenses on the same field share observation", () => {
    const aw = make<{ role: string }>();
    const a = new FieldAwareness(aw, "role");
    const b = new FieldAwareness(aw, "role");

    const seen: unknown[] = [];
    const stop = autorun(() => {
      seen.push(b.get());
    });
    a.set("kernel");
    expect(seen.at(-1)).toBe("kernel");
    expect(b.get()).toBe("kernel");
    stop();
  });

  it("subclass can read through the base lens", () => {
    class UpperRole<A extends PlexusAwareness<{ role: string }>> extends FieldAwareness<A, "role"> {
      upper(): string | null | undefined {
        const v = this.get();
        return typeof v === "string" ? v.toUpperCase() : v;
      }
    }

    const aw = make<{ role: string }>();
    const role = new UpperRole(aw, "role");
    role.set("kernel");
    expect(role.upper()).toBe("KERNEL");
  });

  it("remote replica freeze still resolves the family instance", () => {
    const { doc: docA, plexus: pA, root: rootA } = initTestPlexus(new FaHost());
    const entity = new FaItem({ name: "shared" });
    rootA.items.push(entity);
    docs.push(docA);

    const docB = new Y.Doc({ guid: docA.guid });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const { plexus: pB, root: rootB } = connectTestPlexus<FaHost>(docB);
    docs.push(docB);

    type Shape = { ref: FaItem };
    const src = new FieldAwareness(pA.awareness as PlexusAwareness<Shape>, "ref");
    src.set(entity);
    applyAwarenessUpdate(pB.awareness, encodeAwarenessUpdate(pA.awareness, [...pA.awareness.states.keys()]), "remote");

    const dst = new FieldAwareness(pB.awareness as PlexusAwareness<Shape>, "ref");
    const read = dst.getOther(pA.awareness.clientID);
    expect(read).toBe(rootB.items[0]);
    read!.name = "via-lens";
    expect(rootB.items[0]!.name).toBe("via-lens");
  });
});
