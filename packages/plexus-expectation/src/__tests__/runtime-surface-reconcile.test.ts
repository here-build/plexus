/**
 * Runtime: surface settle + rebind + reconcile (T7 T10 T14 T17 T20 T21 T22 T27).
 * Host = doc-backed PewTestHost; peer claim via second awareness (not a boolean double).
 */
import "@here.build/plexus/mobx/register";
import { PlexusAwareness, PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Expectation } from "../app/index.js";
import { InProcessLaunchDefinition, SurfaceLaunchDefinition, Orchestration } from "../orchestration/index.js";
import { DEFAULT_MAX_REBINDS } from "../runtime/orchestrator.js";
import { PewTestHost } from "./_helpers/test-host.js";

@syncing("@here.build/plexus-expectation:test.Pr4Expectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";

  @syncing accessor payload: string = "";
}

@syncing("@here.build/plexus-expectation:test.Pr4Forest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
}

function launch(mode: "inprocess" | "surface" = "inprocess"): InProcessLaunchDefinition | SurfaceLaunchDefinition {
  return mode === "surface" ? new SurfaceLaunchDefinition() : new InProcessLaunchDefinition();
}

function forestWith(
  units: TestExpectation | TestExpectation[],
  mode: "inprocess" | "surface" = "inprocess",
  actors?: Map<string, InProcessLaunchDefinition | SurfaceLaunchDefinition>,
): TestForest {
  const openWork = Array.isArray(units) ? units : [units];
  return new TestForest({
    orchestration: new Orchestration({
      actors: actors ?? new Map([["test.tool", launch(mode)]]),
    }),
    openWork,
  });
}

describe("PR-4 surface settle / rebind / reconcile", () => {
  let host: PewTestHost | undefined;
  let peerDoc: Y.Doc | undefined;

  beforeEach(() => {
    resetLocalIDs();
    Expectation.bindProgressHub(null);
    host = undefined;
    peerDoc = undefined;
  });
  afterEach(() => {
    host?.dispose();
    peerDoc?.destroy();
    Expectation.bindProgressHub(null);
  });

  it("T7: surface settle seals without process", () => {
    const inprocess = vi.fn();
    const surface = vi.fn(() => {
      /* leave running for settleSurface */
    });
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), { inprocess, surface });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(inprocess).not.toHaveBeenCalled();
    expect(surface).toHaveBeenCalledOnce();
    expect(host.binding.has(E)).toBe(true);

    const result = host.settleSurface(E, {
      epoch: E.bindEpoch,
      disposition: "allow",
    });

    expect(result).toEqual({ ok: true });
    expect(E.state).toBe("sealed");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T7: surface abandon → cancelled", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), { surface: () => {} });

    host.activate(E);
    const result = host.settleSurface(E, {
      epoch: E.bindEpoch,
      disposition: "abandon",
    });
    expect(result).toEqual({ ok: true });
    expect(E.state).toBe("cancelled");
  });

  it("T7: settleSurface not_claim_owner", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), { surface: () => {} });

    host.activate(E);
    expect(E.state).toBe("running");
    host.claimOwner = false;
    const result = host.settleSurface(E, {
      epoch: E.bindEpoch,
      disposition: "allow",
    });
    expect(result).toEqual({ ok: false, code: "not_claim_owner" });
    expect(E.state).toBe("running");
  });

  it("PR-9: activate refuses when isClaimOwner is false (dual-claim / observe-only)", () => {
    const start = vi.fn();
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), { inprocess: start }, { claimOwner: false });

    host.activate(E);
    expect(E.state).toBe("declared");
    expect(start).not.toHaveBeenCalled();
    expect(host.binding.has(E)).toBe(false);
  });

  it("PR-9: peer live client at processorClientId → claim orphan not re-bound locally", () => {
    const E = new TestExpectation({ payload: "in" });
    peerDoc = new Y.Doc();
    const peerHub = new PlexusAwareness(peerDoc);
    // Peer process owns the progressive client for E (1:1 clientId)
    const peerClient = PlexusAwareness.createLocalClient(peerHub);
    E.processorClientId = peerClient.clientID;
    E.transitionState("running");
    E.bindEpoch = 1;

    host = new PewTestHost(
      forestWith(E),
      {
        inprocess: () => {
          /* leave running */
        },
      },
      { peerAwareness: peerHub },
    );

    host.syncPeerFrom(peerHub);
    expect(host.hasLiveClaimPeerBind(E)).toBe(true);
    expect(host.binding.has(E)).toBe(false);

    const epoch = E.bindEpoch;
    host.reconcile();

    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(epoch);
    expect(host.binding.has(E)).toBe(false);
  });

  it("T21: settleSurface stale_epoch returns error to caller", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), { surface: () => {} });

    host.activate(E);
    expect(E.bindEpoch).toBe(1);

    const stale = host.settleSurface(E, {
      epoch: 0,
      disposition: "allow",
    });
    expect(stale).toEqual({ ok: false, code: "stale_epoch" });
    expect(E.state).toBe("running");

    host.dropBind(E);
    const missingBind = host.settleSurface(E, {
      epoch: 1,
      disposition: "deny",
    });
    expect(missingBind).toEqual({ ok: false, code: "stale_epoch" });
    expect(E.state).toBe("running");
  });

  it("T21: settleSurface not_running", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E, "surface"), { surface: () => {} });

    expect(E.state).toBe("declared");
    const result = host.settleSurface(E, {
      epoch: 0,
      disposition: "allow",
    });
    expect(result).toEqual({ ok: false, code: "not_running" });
  });

  it("unhealthy bind on re-activate → onResolverDeath (rebindCount++), not silent restart", () => {
    let starts = 0;
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), {
      inprocess: () => {
        starts += 1;
      },
    });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(starts).toBe(1);
    const handle = host.binding.get(E)!.handle!;
    handle.abort("orphan_abort");
    expect(handle.aborted).toBe(true);
    expect(host.binding.has(E)).toBe(true);

    host.activate(E);
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(1);
    expect(host.binding.has(E)).toBe(false);
    expect(starts).toBe(1);
  });

  it("T10: unexpected death → awaiting_rebind → activate ≤ MAX", () => {
    let starts = 0;
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), {
      inprocess: () => {
        starts += 1;
      },
    });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(starts).toBe(1);
    expect(E.rebindCount).toBe(0);
    const signal1 = host.binding.get(E)!.handle!;

    host.onResolverDeath(E, "process_exit");
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(1);
    expect(host.binding.has(E)).toBe(false);
    expect(signal1.aborted).toBe(true);

    host.activate(E);
    expect(E.state).toBe("running");
    expect(starts).toBe(2);
    expect(E.bindEpoch).toBe(2);
    expect(E.rebindCount).toBe(1);

    for (let i = 0; i < DEFAULT_MAX_REBINDS - 1; i++) {
      host.onResolverDeath(E);
      expect(E.state).toBe("awaiting_rebind");
      host.activate(E);
      expect(E.state).toBe("running");
    }
    expect(E.rebindCount).toBe(DEFAULT_MAX_REBINDS);
    expect(starts).toBe(1 + DEFAULT_MAX_REBINDS);
  });

  it("T17: rebindCount > MAX → failed on activate", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(
      forestWith(E),
      {
        inprocess: () => {
          /* leave running */
        },
      },
      { maxRebinds: 3, modes: new Set(["inprocess", "surface"]) },
    );

    host.activate(E);
    for (let i = 0; i < 4; i++) {
      host.onResolverDeath(E);
      if (E.rebindCount <= 3) {
        host.activate(E);
        expect(E.state).toBe("running");
      }
    }
    expect(E.rebindCount).toBe(4);
    expect(E.state).toBe("awaiting_rebind");

    host.activate(E);
    expect(E.state).toBe("failed");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T20: lease yield aborts then awaiting_rebind; rebindCount unchanged", () => {
    let abortedBeforeState = false;
    let stateWhenAborted: string | undefined;
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), {
      inprocess: (input) => {
        input.signal.addEventListener("abort", () => {
          stateWhenAborted = E.state;
          abortedBeforeState = E.state === "running";
        });
      },
    });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(E.rebindCount).toBe(0);
    const handle = host.binding.get(E)!.handle!;

    host.disposeLease("lease_yield");

    expect(abortedBeforeState).toBe(true);
    expect(stateWhenAborted).toBe("running");
    expect(handle.aborted).toBe(true);
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(0);
    expect(host.binding.has(E)).toBe(false);
    expect(host.activating.has(E)).toBe(false);

    host.activate(E);
    expect(E.state).toBe("running");
    expect(E.rebindCount).toBe(0);
  });

  it("T14: missing → plan added → reconcile activate → running", () => {
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map() }),
      openWork: [E],
    });
    host = new PewTestHost(forest, {
      inprocess: () => {
        /* leave running */
      },
    });

    host.activate(E);
    expect(E.state).toBe("missing");

    forest.orchestration.actors = new Map([["test.tool", launch("inprocess")]]);

    host.reconcile();
    expect(E.state).toBe("running");
    expect(host.binding.has(E)).toBe(true);
  });

  it("T22: reconcile cancelTree on tree orphan", () => {
    const child = new TestExpectation();
    const parent = new TestExpectation({ children: [child] });
    let childAborted = false;
    host = new PewTestHost(
      forestWith(parent),
      {
        inprocess: (input) => {
          input.signal.addEventListener("abort", () => {
            childAborted = true;
          });
        },
      },
      { modes: new Set(["inprocess"]) },
    );

    host.activate(parent);
    host.activate(child);
    expect(parent.state).toBe("running");
    expect(child.state).toBe("running");

    parent.transitionState("sealed");
    host.dropBind(parent);

    host.reconcile();

    expect(child.state).toBe("cancelled");
    expect(childAborted).toBe(true);
    expect(host.binding.has(child)).toBe(false);
  });

  it("T27: forest orphan → cancelled (not rebind)", () => {
    const orphan = new TestExpectation();
    const E = new TestExpectation();
    let orphanAborted = false;
    host = new PewTestHost(
      forestWith(E),
      {
        inprocess: () => {
          /* leave running */
        },
      },
      {
        walkCandidates: () => [E, orphan],
      },
    );

    host.activate(E);
    orphan.transitionState("running");
    orphan.bindEpoch = 1;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      orphanAborted = true;
    });
    host.installBind(orphan, {
      handle: {
        get aborted() {
          return controller.signal.aborted;
        },
        abort(reason?: unknown) {
          if (!controller.signal.aborted) controller.abort(reason);
        },
      },
      epoch: 1,
    });

    expect(orphan.state).toBe("running");
    expect(host.forest.openWork.includes(orphan)).toBe(false);

    host.reconcile();

    expect(orphan.state).toBe("cancelled");
    expect(orphan.rebindCount).toBe(0);
    expect(orphanAborted).toBe(true);
    expect(host.binding.has(orphan)).toBe(false);
    expect(E.state).toBe("running");
  });

  it("claim orphan via reconcile → awaiting_rebind (lease class) then re-activate", () => {
    const E = new TestExpectation({ payload: "in" });
    host = new PewTestHost(forestWith(E), {
      inprocess: () => {
        /* leave running */
      },
    });

    host.activate(E);
    expect(E.state).toBe("running");
    const epochBefore = E.bindEpoch;
    host.dropBind(E);

    host.markAwaitingRebind(E, {
      reason: "claim_orphan",
      incrementRebind: false,
    });
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(0);

    host.activate(E);
    expect(E.state).toBe("running");
    expect(E.rebindCount).toBe(0);
    expect(E.bindEpoch).toBe(epochBefore + 1);
    expect(host.binding.has(E)).toBe(true);
  });
});
