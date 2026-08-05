import { autorun } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  TestExpectation,
  TestLoader,
  TestMessagesDefinition,
} from "./_helpers/test-host.js";
import { PEW } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("PEW §17 presence", () => {
  it("of(E).report is LWW and fires MobX autorun on frame replace", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const pew = host.pew!;
    expect(pew).toBeInstanceOf(PEW);

    const seen: unknown[] = [];
    const stop = autorun(() => {
      seen.push(pew.of(E).report);
    });

    expect(pew.of(E).report).toBeUndefined();
    loader.lastActor!.doReport({ note: "one" });
    expect(pew.of(E).report).toEqual({ note: "one" });
    loader.lastActor!.doReport({ note: "two" });
    expect(pew.of(E).report).toEqual({ note: "two" });

    stop();
    expect(seen.some((f) => f && (f as { note?: string }).note === "one")).toBe(true);
    expect(seen.some((f) => f && (f as { note?: string }).note === "two")).toBe(true);
  });

  it("peer isolation: two sequential activations isolate reports", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const loader = new TestLoader();
    host.plan(TestExpectation.kind, new TestMessagesDefinition(), loader);

    const E1 = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const actor1 = loader.lastActor!;
    const E2 = host.mint(new TestExpectation());
    host.reconcile();
    await flushMicrotasks();
    const actor2 = loader.lastActor!;
    expect(actor1).not.toBe(actor2);
    expect(E1.processorClientId).not.toBe(0);
    expect(E2.processorClientId).not.toBe(0);
    expect(E1.processorClientId).not.toBe(E2.processorClientId);

    const pew = host.pew!;
    let e1Fires = 0;
    const stop = autorun(() => {
      pew.of(E1).report;
      e1Fires += 1;
    });
    const baseline = e1Fires;

    actor2.doReport({ note: "peer" });
    expect(pew.of(E2).report).toEqual({ note: "peer" });
    expect(pew.of(E1).report).toBeUndefined();
    // Peer E2 report must not re-fire a reaction that only read of(E1).report.
    expect(e1Fires).toBe(baseline);

    actor1.doReport({ note: "self" });
    expect(pew.of(E1).report).toEqual({ note: "self" });
    expect(e1Fires).toBeGreaterThan(baseline);
    stop();
  });

  it("mintActorClient / spawn never yields clientId 0", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.processorClientId).not.toBe(0);
    expect(Number.isFinite(E.processorClientId)).toBe(true);

    const client = host.pew!.actors(host.plexus).mintActorClient();
    expect(client.clientID).not.toBe(0);
    client.destroy();
  });

  it("catalog publish surfaces plans after load", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const pew = host.pew!;
    const plan = pew.loaders.plan(TestExpectation.kind);
    expect(plan).toBeDefined();
    expect(plan!.health).toBe("loaded");
    expect(plan!.source).toBe("catalog");
    expect(pew.loaders.plans.get(TestExpectation.kind)?.health).toBe("loaded");
  });

  it("catalog field atoms invalidate plans (MobX autorun)", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const pew = host.pew!;
    const seen: Array<string | undefined> = [];
    const stop = autorun(() => {
      seen.push(pew.loaders.plan(TestExpectation.kind)?.health);
    });
    expect(seen.at(-1)).toBe("loaded");

    // Process-local catalog face → PEW wire; loaders field atom re-fires plans.
    pew.loaders.publish({
      loaders: { [TestExpectation.kind]: "failed:Error: weights missing" },
      capabilities: {},
    });
    expect(seen.at(-1)).toBe("failed:Error: weights missing");
    expect(seen.length).toBeGreaterThan(1);
    stop();
  });

  it("isBound is true after claim publish for a running entity", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    expect(host.pew!.of(E).isBound).toBe(false);
    await activateThroughLoad(host);
    expect(host.pew!.of(E).isBound).toBe(true);
    expect(host.lastClaim().binds.some((b) => b.uuid === E.uuid)).toBe(true);

    host.requestCancellation(E, { strength: "immediate" });
    expect(host.pew!.of(E).isBound).toBe(false);
  });

  it("claim/isBound/ack share one computed claim snapshot (memoized)", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const pew = host.pew!;
    const session = host.plexus;
    const actors = pew.actors(session);

    // Same reaction: claim helpers share one claims computed snapshot.
    let claimRef: (typeof actors)["claim"] | undefined;
    let bound = false;
    const stop = autorun(() => {
      claimRef = actors.claim;
      bound = pew.of(E).isBound;
      void actors.hasDualClaim;
    });
    expect(claimRef).not.toBeNull();
    expect(claimRef!.binds.some((b) => b.uuid === E.uuid)).toBe(true);
    expect(bound).toBe(true);
    expect(actors.hasDualClaim).toBe(false);
    stop();
  });

  it("of(E).report works through PEW after activation (overlapping read path)", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    loader.lastActor!.doReport({ note: "live" });
    expect(host.pew!.of(E).report).toEqual({ note: "live" });
    // Legacy hub walk still agrees when awareness is the session hub.
    expect(E.liveReport(host.awareness!)).toEqual({ note: "live" });

    loader.lastActor!.doComplete({ value: "ok" });
    await flushMicrotasks();
    expect(E.processorClientId).toBe(0);
    expect(host.pew!.of(E).report).toBeUndefined();
    expect(E.lastReport).toEqual({ note: "live" });
  });
});
