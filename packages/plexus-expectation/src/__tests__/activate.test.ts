import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  TestExpectation,
  TestLoader,
  TestMessagesDefinition,
  ThrowingSpawnLoader,
} from "./_helpers/test-host.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("activation", () => {
  it("RUNNING-FIRST: durable running precedes spawn", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    let stateAtSpawn = "";
    loader.onSpawn = () => {
      stateAtSpawn = E.state;
    };
    await activateThroughLoad(host);
    expect(stateAtSpawn).toBe("running");
    expect(host.table.has(E)).toBe(true);
  });

  it("writes the discovery pointer from the spawned handle", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.processorClientId).not.toBe(0);
    expect(host.lastPublished()?.binds).toEqual([{ uuid: E.uuid }]);
  });

  it("missing: no definition for kind; moves onward when the plan appears", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const E = host.mint(new TestExpectation());
    host.reconcile();
    expect(E.state).toBe("missing");

    host.plan(TestExpectation.kind, new TestMessagesDefinition(), new TestLoader());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");
  });

  it("refused: definition without loader association; moves onward when the loader appears", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const def = new TestMessagesDefinition();
    host.plan(TestExpectation.kind, def, null);
    const E = host.mint(new TestExpectation());
    host.reconcile();
    expect(E.state).toBe("refused");

    host.loaders.set(def.constructor, new TestLoader());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");
  });

  it("failed load(): work stays open, health published, no hot loop, rebootstrap recovers", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    loader.failLoad = new Error("weights missing");
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("declared");
    expect(host.lastPublished()?.loaders[TestExpectation.kind]).toBe("failed:Error: weights missing");

    host.reconcile();
    host.reconcile();
    await flushMicrotasks();
    expect(loader.loadCalls).toBe(1);

    loader.failLoad = null;
    host.rebootstrap();
    await flushMicrotasks();
    host.reconcile();
    expect(loader.loadCalls).toBe(2);
    expect(E.state).toBe("running");
  });

  it("spawn throw takes the crash fold", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    host.plan(TestExpectation.kind, new TestMessagesDefinition(), new ThrowingSpawnLoader());
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("failed");
    expect(E.endCause).toBe("crash");
    expect(E.endDetail).toContain("spawn boom");
  });

  it("a settlement emitted synchronously inside spawn folds correctly", async () => {
    const { host, dispose } = makeHost((actor) => {
      actor.doComplete({ value: "quick" });
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    await flushMicrotasks();
    expect(E.state).toBe("sealed");
    expect(E.endCause).toBe("settled");
    expect(E.resultValue).toBe("quick");
  });

  it("synchronous kernel re-entry during spawn cannot bind a handle to a terminal entity", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    loader.onSpawn = () => {
      // A loader closing over the host folds mid-spawn (re-entrant, same stack).
      host.requestCancellation(E, { strength: "immediate", reason: "re-entrant" });
    };
    await activateThroughLoad(host);
    await flushMicrotasks();
    expect(E.state).toBe("cancelled");
    expect(E.endCause).toBe("cancel");
    expect(host.table.has(E)).toBe(false);
    expect(host.lastPublished()?.binds).toEqual([]);
  });

  it("running entities are not re-activated (one execution)", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(loader.spawnCalls).toBe(1);
    host.reconcile();
    host.reconcile();
    expect(loader.spawnCalls).toBe(1);
  });

  it("non-claim-owner never activates", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    host.claimOwner = false;
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("declared");
    expect(loader.spawnCalls).toBe(0);
  });
});
