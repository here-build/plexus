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
import { InProcessLaunchDefinition } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function ackOf(host: PewTestHost, intentId: string): string | undefined {
  return host.lastPublished()?.acks.find((a) => a.intentId === intentId)?.state;
}

describe("steering intents", () => {
  it("admits against a live bound execution and shows the entry in the actor's mailbox", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: { verb: "retry now" } }];
    host.admitIntents();
    expect(ackOf(host, "i1")).toBe("admitted");
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: { verb: "retry now" } }]);
  });

  it("actor outcome folds into the ack and clears the mailbox entry", async () => {
    let mailbox: MailboxView | null = null;
    const { host, loader, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: 1 }];
    host.admitIntents();

    loader.lastActor!.doOutcome("i1", "considered");
    expect(ackOf(host, "i1")).toBe("considered");
    expect(mailbox!.entries).toEqual([]);
  });

  it("refuses: unknown target, terminal target, unbound target, messages not accepted", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);

    const bound = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const unbound = host.mint(new TestExpectation()); // minted after the sweep — still declared

    loader.lastActor!.doComplete({ value: "done" });
    await flushMicrotasks(); // bound is now terminal
    expect(bound.state).toBe("sealed");

    host.authorIntents = [
      { intentId: "ghost", targetUuid: "no-such-uuid", body: null },
      { intentId: "late", targetUuid: bound.uuid, body: null },
      { intentId: "early", targetUuid: unbound.uuid, body: null },
    ];
    host.admitIntents();
    expect(ackOf(host, "ghost")).toBe("refused:target_unbound");
    expect(ackOf(host, "late")).toBe("refused:target_terminal");
    expect(ackOf(host, "early")).toBe("refused:target_unbound");
  });

  it("refuses when the definition does not accept messages", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host.dispose());
    const loader = new TestLoader();
    host.plan(TestExpectation.kind, new InProcessLaunchDefinition(), loader); // acceptsMessages: false
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: null }];
    host.admitIntents();
    expect(ackOf(host, "i1")).toBe("refused:messages_not_accepted");
  });

  it("retract = record removed from the author's presence; ack and mailbox entry drop", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: 1 }];
    host.admitIntents();
    expect(mailbox!.entries).toHaveLength(1);

    host.authorIntents = [];
    host.admitIntents();
    expect(ackOf(host, "i1")).toBeUndefined();
    expect(mailbox!.entries).toEqual([]);
  });

  it("reshape = in-place body edit; no epochs, outcome correlates by intentId only", async () => {
    let mailbox: MailboxView | null = null;
    const { host, loader, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: "v1" }];
    host.admitIntents();
    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: "v2" }];
    host.admitIntents();
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: "v2" }]);
    expect(ackOf(host, "i1")).toBe("admitted");

    loader.lastActor!.doOutcome("i1", "dropped");
    expect(ackOf(host, "i1")).toBe("dropped");
  });

  it("execution end reaps acks; a post-reap outcome folds into nothing", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", targetUuid: E.uuid, body: 1 }];
    host.admitIntents();
    const actor = loader.lastActor!;

    host.requestCancellation(E, { strength: "immediate" });
    expect(ackOf(host, "i1")).toBeUndefined();

    actor.doOutcome("i1", "considered");
    expect(ackOf(host, "i1")).toBeUndefined();
  });
});
