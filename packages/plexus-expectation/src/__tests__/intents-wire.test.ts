/**
 * Steering intents over the REAL wire: an author PEW writes the target's
 * `expectation:${uuid}:intents` lane on its own pen; the bound actor's mailbox
 * is a live lens over that lane — no kernel mirror, no admitIntents for steers.
 *
 * The author is a SECOND PEW instance — mirroring reality (different peer).
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
  it("author publishes lane → live mailbox → retract drops", async () => {
    let mailbox: MailboxView | null = null;
    const { host, dispose } = makeHost((_actor, ctx) => {
      mailbox = ctx.mailbox;
    });
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.actors(host.plexus).setTargetIntents(E, [
      { intentId: "w1", body: { verb: "retry now" } },
    ]);

    expect(mailbox!.entries).toEqual([{ intentId: "w1", body: { verb: "retry now" } }]);

    authorPew.actors(host.plexus).setTargetIntents(E, []);
    expect(mailbox!.entries).toEqual([]);
  });

  it("wire intents targeting a terminal entity are never surfaced", async () => {
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
    authorPew.actors(host.plexus).setTargetIntents(E, [{ intentId: "late", body: null }]);

    expect(mailbox!.entries).toEqual([]);
  });
});
