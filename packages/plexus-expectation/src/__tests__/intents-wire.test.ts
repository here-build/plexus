/**
 * Steering intents over the REAL wire — the round-trip the fake-injection
 * tests never exercised: an author PEW publishes intents into its own presence
 * on the session hub (entity models, serialized by the membrane), the kernel's
 * PEW scan reads them back (models again, resolved on the authoring plane),
 * and admission keys on instance identity against the kernel's table.
 *
 * The author is a SECOND PEW instance — mirroring reality, where the author is
 * a different peer/process — because `readIntents` excludes the kernel's own
 * claim and author pens by design.
 */

import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, makeHost, TestExpectation } from "./_helpers/test-host.js";
import { PEW } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("steering intents over the wire", () => {
  it("author publishes → kernel scan admits → actor outcome folds → retract drops", async () => {
    const { host, loader, dispose } = makeHost();
    cleanup.push(dispose);
    const E = host.mint(new TestExpectation());
    await activateThroughLoad(host);
    expect(E.state).toBe("running");

    // Author side: separate PEW, same session — its author pen is a distinct
    // wire client the kernel's scan must pick up.
    const authorPew = new PEW({ kernel: host.plexus });
    authorPew.actors(host.plexus).publishIntents([{ intentId: "w1", target: E, body: { verb: "retry now" } }]);

    host.admitIntents();
    const ackOf = (id: string) => host.lastClaim().acks.find((a) => a.intentId === id)?.state;
    expect(ackOf("w1")).toBe("admitted");

    loader.lastActor!.doOutcome("w1", "considered");
    expect(ackOf("w1")).toBe("considered");

    // Retract = the author removes the record from their presence.
    authorPew.actors(host.plexus).publishIntents([]);
    host.admitIntents();
    expect(ackOf("w1")).toBeUndefined();
  });

  it("wire intents targeting a terminal entity are refused", async () => {
    const { host, loader, dispose } = makeHost();
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
    expect(host.lastClaim().acks.find((a) => a.intentId === "late")?.state).toBe("refused:target_terminal");
  });
});
