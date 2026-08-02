import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost, TestExpectation } from "./_helpers/test-host.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("reconcile", () => {
  it("tree orphans: open child under terminal parent is folded cancelled/supervision", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const parent = host.mint(new TestExpectation());
    const child = new TestExpectation();
    parent.children.push(child);
    // Simulate a crash-recovered doc: parent terminal, child left open.
    parent.transitionState("running");
    parent.applyTerminal("failed", "crash", "old crash", "null");
    child.transitionState("running");

    host.peerBinds.add(child.uuid); // not a claim orphan — the tree sweep must catch it
    host.reconcile();
    expect(child.state).toBe("cancelled");
    expect(child.endCause).toBe("supervision");
  });

  it("forest orphans: open work unreachable from the roots is folded, never re-executed", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const stray = new TestExpectation(); // never minted into openWork
    host.candidates = [stray];
    host.reconcile();
    expect(stray.state).toBe("cancelled");
    expect(stray.endCause).toBe("supervision");
    expect(stray.endDetail).toBe("orphaned");
  });

  it("claim orphans: running, unbound, no live peer bind → failed/supervision", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    E.transitionState("running"); // as if a dead kernel wrote running and vanished
    host.reconcile();
    expect(E.state).toBe("failed");
    expect(E.endCause).toBe("supervision");
    expect(E.endDetail).toBe("claim_orphan");
  });

  it("a live peer bind shields a running entity from claim-orphan failure", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    E.transitionState("running");
    host.peerBinds.add(E.uuid);
    host.reconcile();
    expect(E.state).toBe("running");
  });
});

describe("lease dispose", () => {
  it("drains buffered settlements — finished work folds sealed, the rest cancelled", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const first = host.mint(new TestExpectation());
    const second = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(first.state).toBe("running");
    expect(second.state).toBe("running");

    // lastActor belongs to `second` (spawned last); it settles a microtask before yield.
    loader.lastActor!.doComplete({ value: "made it" });

    host.disposeLease("lease_yield");
    expect(second.state).toBe("sealed");
    expect(second.endCause).toBe("settled");
    expect(second.resultValue).toBe("made it");
    expect(first.state).toBe("cancelled");
    expect(first.endCause).toBe("supervision");
    expect(first.endDetail).toBe("lease_yield");
    expect(host.table.size).toBe(0);
    await flushMicrotasks();
    expect(second.state).toBe("sealed");
  });

  it("publishes empty binds after dispose", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(host.lastPublished()?.binds).toHaveLength(1);
    host.disposeLease();
    expect(host.lastPublished()?.binds).toHaveLength(0);
  });
});

describe("dual-claim freeze", () => {
  it("a non-claim-owner kernel refuses all verbs", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    host.claimOwner = false;
    host.reconcile();
    expect(E.state).toBe("declared");
    expect(host.requestCancellation(E, { strength: "immediate" })).toEqual({
      ok: false,
      code: "not_claim_owner",
    });
  });
});
