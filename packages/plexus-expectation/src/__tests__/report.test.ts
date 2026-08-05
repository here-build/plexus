import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost, TestExpectation } from "./_helpers/test-host.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("the updates plane", () => {
  it("live frames are observable via the discovery pointer; latest frame wins", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    loader.lastActor!.doReport({ note: "one" });
    expect(host.pew!.of(E).report).toEqual({ note: "one" });
    loader.lastActor!.doReport({ note: "two" });
    expect(host.pew!.of(E).report).toEqual({ note: "two" });
  });

  it("the live read is undefined once the pointer clears; lastReport carries the terminal frame", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doReport({ note: "final" });
    loader.lastActor!.doComplete({ value: "ok" });
    await flushMicrotasks();
    expect(E.processorClientId).toBe(0);
    expect(host.pew!.of(E).report).toBeUndefined();
    expect(E.lastReport).toEqual({ note: "final" });
  });

  it("reports after settlement are ignored (streams close at settle)", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doReport({ note: "kept" });
    loader.lastActor!.doComplete({ value: "ok" });
    loader.lastActor!.doReport({ note: "too late" });
    await flushMicrotasks();
    expect(E.lastReport).toEqual({ note: "kept" });
  });

  it("a hubless kernel still runs: clientId 0 is the no-presence sentinel", async () => {
    const { host, loader, dispose } = makeHost(undefined, { hub: false });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");
    expect(E.processorClientId).toBe(0);
    loader.lastActor!.doComplete({ value: "ok" });
    await flushMicrotasks();
    expect(E.state).toBe("sealed");
  });
});
