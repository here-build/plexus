import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  TestExpectation,
  TestLoader,
  TestMessagesDefinition,
  ThrowingExpectation,
} from "./_helpers/test-host.js";
import { Expectation } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("the fold", () => {
  it("tree-scoped: children reach terminals before the parent's terminal commits", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const parent = host.mint(new TestExpectation());
    const child = new TestExpectation();
    const grandchild = new TestExpectation();
    child.children.push(grandchild);
    parent.children.push(child);
    await activateThroughLoad(host);
    expect(parent.state).toBe("running");
    expect(child.state).toBe("running");
    expect(grandchild.state).toBe("running");

    const order: Expectation[] = [];
    const original = Expectation.prototype.applyTerminal;
    Expectation.prototype.applyTerminal = function (this: Expectation, ...args) {
      order.push(this);
      return original.apply(this, args as Parameters<typeof original>);
    } as typeof original;
    try {
      host.requestCancellation(parent, { strength: "immediate", reason: "test" });
    } finally {
      Expectation.prototype.applyTerminal = original;
    }

    expect(order).toEqual([grandchild, child, parent]);
    expect(parent.state).toBe("cancelled");
    expect(parent.endCause).toBe("cancel");
    expect(child.state).toBe("cancelled");
    expect(child.endCause).toBe("supervision");
    expect(grandchild.endCause).toBe("supervision");
  });

  it("first-writer-wins: the late settlement fold is a no-op, not a throw", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doComplete({ value: "done" });
    host.requestCancellation(E, { strength: "immediate" });
    // Settlement was buffered before the cancel fold ran → SETTLEMENT PREFERENCE seals.
    expect(E.state).toBe("sealed");
    expect(E.endCause).toBe("settled");
    expect(E.resultValue).toBe("done");
    // The queued settlement fold must arrive at the terminal entity and no-op.
    await flushMicrotasks();
    expect(E.state).toBe("sealed");
  });

  it("settlement preference also seals children caught in a parent cascade", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const parent = host.mint(new TestExpectation());
    const child = new TestExpectation();
    parent.children.push(child);
    await activateThroughLoad(host);

    // The loader's lastActor is the most recently spawned — order is parent-first.
    const childActor = loader.lastActor!;
    childActor.doComplete({ value: "child-done" });
    host.requestCancellation(parent, { strength: "immediate" });

    expect(child.state).toBe("sealed");
    expect(child.endCause).toBe("settled");
    expect(child.resultValue).toBe("child-done");
    expect(parent.state).toBe("cancelled");
  });

  it("abort-reaction settlements are NOT honored (snapshot precedes abort)", async () => {
    const { host, dispose } = makeHost((actor, ctx) => {
      ctx.signal.addEventListener("abort", () => actor.doComplete({ value: "flushed on abort" }));
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.requestCancellation(E, { strength: "immediate" });
    expect(E.state).toBe("cancelled");
    expect(E.endCause).toBe("cancel");
    await flushMicrotasks();
    expect(E.state).toBe("cancelled");
  });

  it("folds the last report on every path: seal, fail, crash, cancel", async () => {
    // seal
    {
      const { host, loader, dispose } = makeHost();
      cleanup.push(dispose);
      const E = host.mint(new TestExpectation());
      await activateThroughLoad(host);
      loader.lastActor!.doReport({ note: "halfway" });
      loader.lastActor!.doComplete({ value: "ok" });
      await flushMicrotasks();
      expect(E.state).toBe("sealed");
      expect(E.lastReport).toEqual({ note: "halfway" });
    }
    // fail
    {
      const { host, loader, dispose } = makeHost();
      cleanup.push(dispose);
      const E = host.mint(new TestExpectation());
      await activateThroughLoad(host);
      loader.lastActor!.doReport({ note: "before fail" });
      loader.lastActor!.doFail("tool exploded");
      await flushMicrotasks();
      expect(E.state).toBe("failed");
      expect(E.endCause).toBe("settled");
      expect(E.endDetail).toBe("tool exploded");
      expect(E.lastReport).toEqual({ note: "before fail" });
    }
    // crash (run throws)
    {
      const { host, dispose } = makeHost((actor) => {
        actor.doReport({ note: "before crash" });
        throw new Error("boom");
      });
      cleanup.push(dispose);
      const E = host.mint(new TestExpectation());
      await activateThroughLoad(host);
      await flushMicrotasks();
      expect(E.state).toBe("failed");
      expect(E.endCause).toBe("crash");
      expect(E.endDetail).toContain("boom");
      expect(E.lastReport).toEqual({ note: "before crash" });
    }
    // cancel
    {
      const { host, loader, dispose } = makeHost();
      cleanup.push(dispose);
      const E = host.mint(new TestExpectation());
      await activateThroughLoad(host);
      loader.lastActor!.doReport({ note: "mid-flight" });
      host.requestCancellation(E, { strength: "immediate", reason: "user said stop" });
      expect(E.state).toBe("cancelled");
      expect(E.endDetail).toBe("user said stop");
      expect(E.lastReport).toEqual({ note: "mid-flight" });
    }
  });

  it("a frame that fails to serialize crashes the actor and keeps the last GOOD frame", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doReport({ note: "good" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    loader.lastActor!.doReport(circular);
    await flushMicrotasks();
    expect(E.state).toBe("failed");
    expect(E.endCause).toBe("crash");
    expect(E.lastReport).toEqual({ note: "good" });
  });

  it("applySettlement throw: terminal commits with the partial-apply marker, no zombie running", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const loader = new TestLoader();
    host.plan(ThrowingExpectation.kind, new TestMessagesDefinition(), loader);
    const E = host.mint(new ThrowingExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doComplete({ value: "partial" });
    await flushMicrotasks();
    expect(E.state).toBe("sealed");
    expect(E.endCause).toBe("settled");
    expect(E.endDetail).toContain("apply_error");
    expect(E.resultValue).toBe("partial"); // the write before the throw committed — partial by contract
    expect(host.table.has(E)).toBe(false);
  });

  it("reap clears the discovery pointer and the table entry", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.processorClientId).not.toBe(0);
    loader.lastActor!.doComplete({ value: "x" });
    await flushMicrotasks();
    expect(E.processorClientId).toBe(0);
    expect(host.table.size).toBe(0);
  });

  it("cancelling declared work folds it without any actor", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const E = host.mint(new TestExpectation());
    const result = host.requestCancellation(E, { strength: "immediate" });
    expect(result).toEqual({ ok: true });
    expect(E.state).toBe("cancelled");
    expect(E.lastReportJson).toBe("null");
  });

  it("cooperative cancel is a typed stub-refusal", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const E = host.mint(new TestExpectation());
    expect(host.requestCancellation(E, { strength: "cooperative" })).toEqual({
      ok: false,
      code: "cooperative_not_implemented",
    });
  });
});
