import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  TestExpectation,
  TestLoader,
} from "./_helpers/test-host.js";
import { type MailboxView } from "../executor/index.js";
import {
  cancellationLaneField,
  InProcessLaunchDefinition,
  intentLaneField,
  PEW,
} from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("steering intents (live lane — no kernel mirror)", () => {
  it("standing intent on the target's lane lands in the bound actor's mailbox", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const author = new PEW({ kernel: host.plexus });
    const intentId = author.request(E, { note: "retry now" });
    expect(mailbox!.entries).toEqual([{ intentId, body: { note: "retry now" } }]);
  });

  it("an entry stands while the lane holds it — what the actor does is its own business", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const author = new PEW({ kernel: host.plexus });
    const intentId = author.request(E, { note: "x" } as never);
    // Live lens — re-read is the same standing entry (no admit sweep).
    expect(mailbox!.entries).toEqual([{ intentId, body: { note: "x" } }]);
    expect(mailbox!.entries).toEqual([{ intentId, body: { note: "x" } }]);
  });

  it("never surfaces: terminal target, unbound target (no actor mailbox yet)", async () => {
    let mailbox: MailboxView | null = null;
    const { host, loader, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);

    const bound = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const unbound = host.mint(new TestExpectation()); // declared — no actor

    loader.lastActor!.doComplete({ value: "done" });
    await flushMicrotasks();
    expect(bound.state).toBe("sealed");

    const author = new PEW({ kernel: host.plexus });
    author.request(bound, { note: "late" });
    author.request(unbound, { note: "early" });
    // Bound is terminal → live mailbox empty; unbound has no mailbox object.
    expect(mailbox!.entries).toEqual([]);
    expect(unbound.state).toBe("declared");
  });

  it("does not surface when the definition does not accept messages", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    let mailbox: MailboxView | null = null;
    const loader = new TestLoader((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    host.plan(TestExpectation.kind, new InProcessLaunchDefinition(), loader); // acceptsMessages: false
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    const author = new PEW({ kernel: host.plexus });
    author.request(E, { note: "nope" } as never);
    expect(mailbox!.entries).toEqual([]);
  });

  it("front-run needs no ledger: an early intent lands once the target binds", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    const author = new PEW({ kernel: host.plexus });
    const intentId = author.request(E, { note: "steer" });
    expect(mailbox).toBeNull(); // not activated yet

    await activateThroughLoad(host);
    expect(E.state).toBe("running");
    expect(mailbox!.entries).toEqual([{ intentId, body: { note: "steer" } }]);
  });

  it("retract = absence: the entry drops when the author clears the lane", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const author = new PEW({ kernel: host.plexus });
    author.request(E, { note: "1" });
    expect(mailbox!.entries).toHaveLength(1);

    author.actors(host.plexus).setTargetIntents(E, []);
    expect(mailbox!.entries).toEqual([]);
  });

  it("reshape = rewrite the lane list (same intentId, new body)", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const actors = new PEW({ kernel: host.plexus }).actors(host.plexus);
    actors.setTargetIntents(E, [{ intentId: "i1", body: "v1" }]);
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: "v1" }]);
    actors.setTargetIntents(E, [{ intentId: "i1", body: "v2" }]);
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: "v2" }]);
  });

  it("reap / terminal: live mailbox empties when the execution ends", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const author = new PEW({ kernel: host.plexus });
    author.request(E, { note: "1" });
    expect(mailbox!.entries).toHaveLength(1);

    host.requestCancellation(E, { strength: "immediate" });
    expect(mailbox!.entries).toEqual([]);
  });

  it("lane field names are expectation:${uuid}:intents and :cancellation", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const author = new PEW({ kernel: host.plexus });
    author.request(E, { note: "n" });
    author.requestCancellation(E, { reason: "stop" });

    const intentsKey = intentLaneField(E.uuid);
    const cancelKey = cancellationLaneField(E.uuid);
    expect(intentsKey).toBe(`expectation:${E.uuid}:intents`);
    expect(cancelKey).toBe(`expectation:${E.uuid}:cancellation`);

    const hub = host.plexus.awareness;
    let foundIntents = false;
    let foundCancel = false;
    for (const id of hub.reactive.clientIds) {
      const client = hub.reactive.clients.get(id);
      const intents = client.field(intentsKey);
      const cancels = client.field(cancelKey);
      if (Array.isArray(intents) && intents.length > 0) foundIntents = true;
      if (Array.isArray(cancels) && cancels.length > 0) foundCancel = true;
    }
    expect(foundIntents).toBe(true);
    expect(foundCancel).toBe(true);

    // Cancel is not mixed into the actor mailbox.
    // (mailbox captured only when actor scripts; re-activate not needed — field check above)
  });
});
