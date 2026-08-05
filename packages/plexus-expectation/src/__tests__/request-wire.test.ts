/**
 * The author face: `pew.request(target, intent)` / `pew.requestCancellation`.
 *
 * Named for what should happen, not how internals work. No session parameter —
 * the target carries its hub (`E.__doc__` → family → awareness), so a
 * cross-session mistake is unrepresentable. No acks either: a steer stands in
 * the author's presence until its target ends (the prune on next submission IS
 * the retract), the kernel mirrors standing steers into the actor's inbox, and
 * outcomes — if any — are observable through the report stream and the durable
 * plane, nowhere else.
 *
 * Topology mirrors intents-wire.test.ts: the author is a SECOND PEW instance,
 * because the kernel's scan excludes its own pens by design.
 */

import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost, TestExpectation } from "./_helpers/test-host.js";
import { type MailboxView } from "../executor/index.js";
import { PEW } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("pew.request", () => {
  it("round-trip: request lands in the actor's inbox and stands while the work runs", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const authorPew = new PEW({ kernel: host.plexus });
    const first = authorPew.request(E, { note: "steer one" });
    expect(typeof first).toBe("string");

    host.admitIntents();
    expect(mailbox!.entries).toEqual([{ intentId: first, body: { note: "steer one" } }]);

    // A second steer joins — both stand; the actor decides what each means.
    const second = authorPew.request(E, { note: "steer two" });
    host.admitIntents();
    expect(mailbox!.entries.map((entry) => entry.intentId)).toEqual([first, second]);
  });

  it("records prune once the target ends — the retract the inbox mirror keys on", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.request(E, { note: "while running" });
    expect(host.getAuthorIntents()).toHaveLength(1);

    loader.lastActor!.doComplete({ value: "ok" });
    await flushMicrotasks();
    expect(E.state).toBe("sealed");

    // Next submission prunes the sealed target's record.
    const E2 = host.mint(new TestExpectation());
    host.reconcile();
    await flushMicrotasks();
    const fresh = authorPew.request(E2, { note: "fresh" });
    expect(host.getAuthorIntents().map((intent) => intent.intentId)).toEqual([fresh]);
  });

  it("request minted ids are distinct", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const authorPew = new PEW({ kernel: host.plexus });
    const a = authorPew.request(E, { note: "a" });
    const b = authorPew.request(E, { note: "b" });
    expect(a).not.toBe(b);
  });

  it("request against an unhomed target throws loudly", () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const stray = new TestExpectation();
    const authorPew = new PEW({ kernel: host.plexus });
    expect(() => authorPew.request(stray, { note: "nowhere" })).toThrow(/session hub/);
  });
});

describe("pew.requestCancellation", () => {
  it("running target: kernel folds to cancelled — the durable plane is the acknowledgment", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.requestCancellation(E, { reason: "user abort" });

    host.admitIntents();
    await flushMicrotasks();
    expect(E.state).toBe("cancelled");
    expect(E.endCause).toBe("cancel");
    expect(E.endDetail).toBe("user abort");
  });

  it("declared (not yet running) target is cancellable — envelope verb, not an inbox message", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    // Never reconciled: E stays declared, no actor, no bind.
    const E = host.mint(new TestExpectation());
    expect(E.state).toBe("declared");

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.requestCancellation(E);

    host.admitIntents();
    expect(E.state).toBe("cancelled");
  });

  it("cooperative strength is not implemented: nothing happens, state untouched", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.requestCancellation(E, { strength: "cooperative" });

    host.admitIntents();
    expect(E.state).toBe("running");
  });

  it("terminal target: a no-op, and the record prunes on the author's next submission", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doComplete({ value: "done" });
    await flushMicrotasks();
    expect(E.state).toBe("sealed");

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.requestCancellation(E);
    host.admitIntents();
    expect(E.state).toBe("sealed");

    const E2 = host.mint(new TestExpectation());
    host.reconcile();
    await flushMicrotasks();
    const fresh = authorPew.request(E2, { note: "fresh" });
    expect(host.getAuthorIntents().map((intent) => intent.intentId)).toEqual([fresh]);
  });
});
