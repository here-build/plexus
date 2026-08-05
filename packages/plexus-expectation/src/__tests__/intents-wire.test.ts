/**
 * Steering intents over the REAL wire — the round-trip the fake-injection
 * tests never exercised: an author PEW publishes intents into its own presence
 * on the session hub (entity models, serialized by the membrane), the kernel's
 * PEW scan reads them back (models again, resolved on the authoring plane),
 * and the inbox mirror keys on instance identity against the kernel's table.
 *
 * The author is a SECOND PEW instance — mirroring reality, where the author is
 * a different peer/process — because the kernel's scan excludes its own claim
 * and author pens by design.
 */

import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, makeHost, TestExpectation } from "./_helpers/test-host.js";
import { type MailboxView } from "../executor/index.js";
import { PEW } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("steering intents over the wire", () => {
  it("author publishes → kernel scan mirrors into the inbox → retract drops", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    // Author side: separate PEW, same session — its author pen is a distinct
    // wire client the kernel's scan must pick up.
    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.actors(host.plexus).publishIntents([{ intentId: "w1", target: E, body: { verb: "retry now" } }]);

    host.admitIntents();
    expect(mailbox!.entries).toEqual([{ intentId: "w1", body: { verb: "retry now" } }]);

    // Retract = the author removes the record from their presence.
    authorPew.actors(host.plexus).publishIntents([]);
    host.admitIntents();
    expect(mailbox!.entries).toEqual([]);
  });

  it("wire intents targeting a terminal entity are never mirrored", async () => {
    let mailbox: MailboxView | null = null;
    const { host, loader, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    loader.lastActor!.doComplete({ value: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(E.state).toBe("sealed");

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.actors(host.plexus).publishIntents([{ intentId: "late", target: E, body: null }]);

    host.admitIntents();
    expect(mailbox!.entries).toEqual([]);
  });
});
