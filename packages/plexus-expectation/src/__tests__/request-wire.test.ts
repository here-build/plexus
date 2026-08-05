/**
 * The author face: `pew.request(target, intent)` / `pew.requestCancellation`.
 *
 * Named for what should happen, not how internals work. No session parameter —
 * the target carries its hub (`E.__doc__` → family → awareness), so a
 * cross-session mistake is unrepresentable. PEW owns the author bookkeeping:
 * records stay in presence until acked terminally (considered/dropped) or the
 * target seals, then prune on the next submission — the prune IS the retract,
 * which is what lets the kernel clean its ack ledger (§8).
 *
 * Topology mirrors intents-wire.test.ts: the author is a SECOND PEW instance,
 * because the kernel's scan excludes its own pens by design.
 */

import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost, TestExpectation } from "./_helpers/test-host.js";
import { PEW } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("pew.request", () => {
  it("round-trip: request → admit → actor outcome → prune on next submission", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const authorPew = new PEW({ kernel: host.plexus });
    const first = authorPew.request(E, { note: "steer one" });
    expect(typeof first).toBe("string");

    host.admitIntents();
    const ackOf = (id: string) => host.lastClaim().acks.find((a) => a.intentId === id)?.state;
    expect(ackOf(first)).toBe("admitted");

    loader.lastActor!.doOutcome(first, "considered");
    expect(ackOf(first)).toBe("considered");

    // Next submission prunes the acked record — the retract the kernel's
    // ack-ledger cleanup keys on.
    const second = authorPew.request(E, { note: "steer two" });
    host.admitIntents();
    expect(ackOf(first)).toBeUndefined();
    expect(ackOf(second)).toBe("admitted");
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
  it("running target: kernel folds to cancelled, ack considered", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    const authorPew = new PEW({ kernel: host.plexus });
    const id = authorPew.requestCancellation(E, { reason: "user abort" });

    host.admitIntents();
    await flushMicrotasks();
    expect(E.state).toBe("cancelled");
    expect(E.endCause).toBe("cancel");
    expect(E.endDetail).toBe("user abort");
    expect(host.lastClaim().acks.find((a) => a.intentId === id)?.state).toBe("considered");
  });

  it("declared (not yet running) target is cancellable — envelope verb, not a mailbox message", async () => {
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

  it("cooperative strength is not implemented: ack dropped, state untouched", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const authorPew = new PEW({ kernel: host.plexus });
    const id = authorPew.requestCancellation(E, { strength: "cooperative" });

    host.admitIntents();
    expect(E.state).toBe("running");
    expect(host.lastClaim().acks.find((a) => a.intentId === id)?.state).toBe("dropped");
  });

  it("terminal target: refused, then pruned on the author's next submission", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doComplete({ value: "done" });
    await flushMicrotasks();
    expect(E.state).toBe("sealed");

    const authorPew = new PEW({ kernel: host.plexus });
    const late = authorPew.requestCancellation(E);
    host.admitIntents();
    expect(host.lastClaim().acks.find((a) => a.intentId === late)?.state).toBe("refused:target_terminal");

    // Terminal-target records prune on next submission; the kernel then
    // clears the refusal from its ledger.
    const E2 = host.mint(new TestExpectation());
    host.reconcile();
    await flushMicrotasks();
    authorPew.request(E2, { note: "fresh" });
    host.admitIntents();
    expect(host.lastClaim().acks.find((a) => a.intentId === late)).toBeUndefined();
  });
});
