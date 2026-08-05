/**
 * §17.5 / §15 wire-level claim + catalog behavior over REAL presence records —
 * the rows the fake-injection era never covered: dual-claim via two live claim
 * records, install-time eviction, rediscovery after retire, overlapping
 * reload, loader self-record merge, and the two-doc topology split.
 */

import { Plexus } from "@here.build/plexus";
import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, makeHost, PewForest, TestExpectation } from "./_helpers/test-host.js";
import { PEW } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("claim records on the wire (§17.5)", () => {
  it("a second live claim record freezes activation both ways (dual-claim)", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    const E1 = host.mint(new TestExpectation());
    await activateThroughLoad(host); // own claim record published

    const rival = new PEW({ kernel: host.plexus });
    rival.actors(host.plexus).publishClaim({ binds: [] });

    expect(host.pew!.actors(host.plexus).hasDualClaim).toBe(true);
    expect(host.pew!.actors(host.plexus).claim).toBeNull(); // no sole claim under dual

    const E2 = host.mint(new TestExpectation());
    host.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(E2.state).toBe("declared"); // frozen — never activated
    expect(E1.state).toBe("running"); // held work untouched by the freeze

    rival.actors(host.plexus).retireClaim();
    host.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(E2.state).toBe("running"); // dual cleared — activation resumes
  });

  it("installClaim evicts stale claim peers before publishing its own", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);

    // A dead predecessor's claim record (its process is gone; record lingers).
    const corpse = new PEW({ kernel: host.plexus });
    corpse.actors(host.plexus).publishClaim({ binds: [] });
    expect(host.pew!.actors(host.plexus).hasDualClaim).toBe(true);

    host.pew!.actors(host.plexus).installClaim();
    const claims = host.pew!.actors(host.plexus).claims;
    expect(claims.length).toBe(1); // corpse evicted, own claim re-minted
    expect(host.pew!.actors(host.plexus).hasDualClaim).toBe(false);
  });

  it("claim rediscovery: retire → none; new claim under a new id → found by scan", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const actors = host.pew!.actors(host.plexus);
    const before = actors.claim;
    expect(before).not.toBeNull();

    actors.retireClaim();
    expect(actors.claim).toBeNull(); // no sticky clientId cache

    actors.publishClaim({ binds: [] });
    const after = actors.claim;
    expect(after).not.toBeNull();
    expect(after!.clientId).not.toBe(before!.clientId); // fresh identity, rediscovered
  });

  it("overlapping reload: at least one claim record is live at every instant", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host);

    const actors = host.pew!.actors(host.plexus);
    const oldId = actors.claim!.clientId;

    actors.reloadClaim(host.claimPresence());
    const rotated = actors.claim;
    expect(rotated).not.toBeNull(); // exactly one live record after rotation
    expect(rotated!.clientId).not.toBe(oldId); // and it is the NEW one
  });
});

describe("catalog merge (§17.4)", () => {
  it("a loader self-record's capability wins; catalog health stays authoritative", async () => {
    const { host, dispose } = makeHost();
    cleanup.push(dispose);
    host.mint(new TestExpectation());
    await activateThroughLoad(host); // catalog published: health=loaded

    // Self-managed loader publishes its own record for the same kind.
    const hub = host.plexus.awareness;
    const self = (await import("../shared/presence.js")).mintLocalNonZero(hub);
    cleanup.push(() => self.destroy());
    self.setField("role", "loader" as never);
    self.setField("kind", TestExpectation.kind as never);
    self.setField("capability", { status: "blocked", door: "run /connect first" } as never);

    const plan = host.pew!.loaders.plan(TestExpectation.kind);
    expect(plan!.health).toBe("loaded"); // catalog pen authoritative
    expect(plan!.capability?.status).toBe("blocked"); // self-record capability wins
    expect(plan!.source).toBe("both");
  });
});

describe("two-doc topology (§17.1)", () => {
  it("catalog lives on the kernel hub; execution on the session hub; neither leaks", async () => {
    const kernelPlexus = Plexus.bootstrap(new PewForest());
    cleanup.push(() => kernelPlexus.destroy());
    const { host, dispose } = makeHost();
    cleanup.push(dispose);

    // Split-brain PEW: kernel doc ≠ session doc (DO topology).
    const pew = new PEW({ kernel: kernelPlexus });
    pew.loaders.publish({ loaders: { [TestExpectation.kind]: "loaded" }, capabilities: {} });
    pew.actors(host.plexus).publishClaim({ binds: [] });

    // Catalog readable via the kernel hub; absent from the session hub's claim face.
    expect(pew.loaders.plan(TestExpectation.kind)?.health).toBe("loaded");
    expect(pew.actors(host.plexus).claims.length).toBeGreaterThan(0);

    // A session-only observer (kernel: null) sees execution but no catalog.
    const observer = new PEW();
    expect(observer.loaders.plan(TestExpectation.kind)).toBeUndefined();
    expect(observer.actors(host.plexus).claims.length).toBeGreaterThan(0);
  });
});
