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
  it("reportOf is LWW and fires MobX autorun on frame replace", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const pew = host.pew!;
    expect(pew).toBeInstanceOf(PEW);

    const seen: unknown[] = [];
    const stop = autorun(() => {
      seen.push(pew.reportOf(E));
    });

    expect(pew.reportOf(E)).toBeUndefined();
    loader.lastActor!.doReport({ note: "one" });
    expect(pew.reportOf(E)).toEqual({ note: "one" });
    loader.lastActor!.doReport({ note: "two" });
    expect(pew.reportOf(E)).toEqual({ note: "two" });

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
      pew.reportOf(E1);
      e1Fires += 1;
    });
    const baseline = e1Fires;

    actor2.doReport({ note: "peer" });
    expect(pew.reportOf(E2)).toEqual({ note: "peer" });
    expect(pew.reportOf(E1)).toBeUndefined();
    // Peer E2 report must not re-fire a reaction that only read reportOf(E1).
    expect(e1Fires).toBe(baseline);

    actor1.doReport({ note: "self" });
    expect(pew.reportOf(E1)).toEqual({ note: "self" });
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

    const client = host.pew!.mintActorClient(host.plexus);
    expect(client.clientID).not.toBe(0);
    client.destroy();
  });

  it("catalog publish surfaces plans after load", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const pew = host.pew!;
    const plan = pew.plan(TestExpectation.kind);
    expect(plan).toBeDefined();
    expect(plan!.health).toBe("loaded");
    expect(plan!.source).toBe("catalog");
    expect(pew.plans.get(TestExpectation.kind)?.health).toBe("loaded");
  });

  it("isBound is true after claim publish for a running entity", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    expect(host.pew!.isBound(E)).toBe(false);
    await activateThroughLoad(host);
    expect(host.pew!.isBound(E)).toBe(true);
    expect(host.lastPublished().binds.some((b) => b.uuid === E.uuid)).toBe(true);

    host.requestCancellation(E, { strength: "immediate" });
    expect(host.pew!.isBound(E)).toBe(false);
  });

  it("claim/isBound/ack share one computed claim snapshot (memoized)", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const pew = host.pew!;
    const session = host.plexus;

    // Same reaction: claim helpers must not re-scan independently in a way that
    // disagrees; computed returns a stable snapshot for one claimVersion.
    let claimRef: ReturnType<typeof pew.claim> | undefined;
    let bound = false;
    const stop = autorun(() => {
      claimRef = pew.claim(session);
      bound = pew.isBound(E);
      void pew.hasDualClaim(session);
    });
    expect(claimRef).not.toBeNull();
    expect(claimRef!.binds.some((b) => b.uuid === E.uuid)).toBe(true);
    expect(bound).toBe(true);
    expect(pew.hasDualClaim(session)).toBe(false);
    stop();
  });

  it("reportOf works through PEW after activation (overlapping read path)", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    loader.lastActor!.doReport({ note: "live" });
    expect(host.pew!.reportOf(E)).toEqual({ note: "live" });
    // Legacy hub walk still agrees when awareness is the session hub.
    expect(E.liveReport(host.awareness!)).toEqual({ note: "live" });

    loader.lastActor!.doComplete({ value: "ok" });
    await flushMicrotasks();
    expect(E.processorClientId).toBe(0);
    expect(host.pew!.reportOf(E)).toBeUndefined();
    expect(E.lastReport).toEqual({ note: "live" });
  });
});
