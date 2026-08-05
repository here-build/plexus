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

describe("steering intents (inbox contract — no acks)", () => {
  it("mirrors a standing intent into the bound actor's inbox", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    host.authorIntents = [{ intentId: "i1", target: E, body: { verb: "retry now" } }];
    host.admitIntents();
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: { verb: "retry now" } }]);
  });

  it("an entry stands across sweeps while the intent stays authored — what the actor does with it is its own business", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", target: E, body: 1 }];
    host.admitIntents();
    host.admitIntents();
    host.admitIntents();
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: 1 }]);
  });

  it("never mirrors: unknown target, terminal target, unbound target", async () => {
    let mailbox: MailboxView | null = null;
    const { host, loader, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);

    const bound = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    const unbound = host.mint(new TestExpectation()); // minted after the sweep — still declared

    loader.lastActor!.doComplete({ value: "done" });
    await flushMicrotasks(); // bound is now terminal
    expect(bound.state).toBe("sealed");

    // Ghost target: unminted entity (never home'd into the forest).
    const ghost = new TestExpectation();
    host.authorIntents = [
      { intentId: "ghost", target: ghost, body: null },
      { intentId: "late", target: bound, body: null },
      { intentId: "early", target: unbound, body: null },
    ];
    host.admitIntents();
    expect(mailbox!.entries).toEqual([]);
    expect(unbound.state).toBe("declared");
  });

  it("does not mirror when the definition does not accept messages", async () => {
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

    host.authorIntents = [{ intentId: "i1", target: E, body: null }];
    host.admitIntents();
    expect(mailbox!.entries).toEqual([]);
  });

  it("front-run needs no ledger: an early intent lands once the target binds", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    host.authorIntents = [{ intentId: "early-bird", target: E, body: "steer" }];
    host.admitIntents(); // target declared, not bound yet — nothing mirrored, nothing recorded
    expect(mailbox).toBeNull();

    await activateThroughLoad(host); // reconcile sweeps again after bind
    expect(E.state).toBe("running");
    expect(mailbox!.entries).toEqual([{ intentId: "early-bird", body: "steer" }]);
  });

  it("retract = absence: the entry drops when the intent leaves the author's presence", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", target: E, body: 1 }];
    host.admitIntents();
    expect(mailbox!.entries).toHaveLength(1);

    host.authorIntents = [];
    host.admitIntents();
    expect(mailbox!.entries).toEqual([]);
  });

  it("reshape = in-place upsert by intentId; no epochs", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", target: E, body: "v1" }];
    host.admitIntents();
    host.authorIntents = [{ intentId: "i1", target: E, body: "v2" }];
    host.admitIntents();
    expect(mailbox!.entries).toEqual([{ intentId: "i1", body: "v2" }]);
  });

  it("reap empties the inbox: a captured view reads empty after the execution ends", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    host.authorIntents = [{ intentId: "i1", target: E, body: 1 }];
    host.admitIntents();
    expect(mailbox!.entries).toHaveLength(1);

    host.requestCancellation(E, { strength: "immediate" });
    expect(mailbox!.entries).toEqual([]);
  });
});
