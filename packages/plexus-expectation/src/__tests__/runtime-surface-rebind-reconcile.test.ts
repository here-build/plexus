/**
 * PR-4 runtime: surface settle + rebind + reconcile
 * (T7 T10 T14 T17 T20 T21 T22 T27).
 */
import "@here.build/plexus/mobx/register";

import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Expectation } from "../app/index.js";
import { LaunchDefinition, Orchestration } from "../orchestration/index.js";
import {
  DEFAULT_MAX_REBINDS,
  modulesFromRecord,
  Orchestrator,
  type StartResolverFn,
} from "../runtime/index.js";

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

function def(mode: "inprocess" | "surface" = "inprocess"): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: mode,
    acceptsMessages: false,
    emitsProgress: false,
    progressMode: "none",
  });
}

function makeOrch(opts: {
  actors?: ReadonlyArray<readonly [string, LaunchDefinition]>;
  loaded?: ReadonlySet<string>;
  start?: StartResolverFn;
  modules?: Record<string, StartResolverFn>;
  isClaimOwner?: boolean | (() => boolean);
  maxRebinds?: number;
  openWork?: TestExpectation[];
  walkCandidates?: () => Iterable<Expectation>;
  hasLiveClaimPeerBind?: (E: Expectation) => boolean;
}): {
  forest: TestForest;
  orchestrator: Orchestrator;
  E: TestExpectation;
} {
  const launch = def("inprocess");
  const actors = opts.actors ?? [["test.tool", launch]];
  const E = opts.openWork?.[0] ?? new TestExpectation({ payload: "in" });
  const openWork = opts.openWork ?? [E];
  const forest = new TestForest({
    orchestration: new Orchestration({
      actors: new Map(actors),
    }),
    openWork,
  });

  const modules =
    opts.modules ??
    (opts.start
      ? { inprocess: opts.start }
      : {
          inprocess: (() => {
            /* leave running */
          }) satisfies StartResolverFn,
        });

  const orchestrator = new Orchestrator({
    getOrchestration: () => forest.orchestration,
    loadedModules: opts.loaded ?? new Set(["inprocess", "surface"]),
    modules: modulesFromRecord(modules),
    isClaimOwner: opts.isClaimOwner,
    maxRebinds: opts.maxRebinds,
    getOpenWorkRoots: () => forest.openWork,
    walkCandidates: opts.walkCandidates,
    hasLiveClaimPeerBind: opts.hasLiveClaimPeerBind,
  });

  return { forest, orchestrator, E };
}

describe("PR-4 surface settle / rebind / reconcile", () => {
  beforeEach(() => resetLocalIDs());

  it("T7: surface settle seals without process", () => {
    const start = vi.fn();
    const { orchestrator, E } = makeOrch({
      actors: [["test.tool", def("surface")]],
      modules: { inprocess: start, surface: start },
    });

    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(start).not.toHaveBeenCalled();
    expect(orchestrator.binding.has(E)).toBe(true);

    const result = orchestrator.settleSurface(E, {
      epoch: E.bindEpoch,
      disposition: "allow",
    });

    expect(result).toEqual({ ok: true });
    expect(E.state).toBe("sealed");
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("T7: surface abandon → cancelled", () => {
    const { orchestrator, E } = makeOrch({
      actors: [["test.tool", def("surface")]],
      modules: { surface: () => {} },
    });
    orchestrator.activate(E);
    const result = orchestrator.settleSurface(E, {
      epoch: E.bindEpoch,
      disposition: "abandon",
    });
    expect(result).toEqual({ ok: true });
    expect(E.state).toBe("cancelled");
  });

  it("T7: settleSurface not_claim_owner", () => {
    const { orchestrator, E } = makeOrch({
      actors: [["test.tool", def("surface")]],
      modules: { surface: () => {} },
      isClaimOwner: false,
    });
    orchestrator.activate(E);
    const result = orchestrator.settleSurface(E, {
      epoch: E.bindEpoch,
      disposition: "allow",
    });
    expect(result).toEqual({ ok: false, code: "not_claim_owner" });
    expect(E.state).toBe("running");
  });

  it("T21: settleSurface stale_epoch returns error to caller", () => {
    const { orchestrator, E } = makeOrch({
      actors: [["test.tool", def("surface")]],
      modules: { surface: () => {} },
    });
    orchestrator.activate(E);
    expect(E.bindEpoch).toBe(1);

    const stale = orchestrator.settleSurface(E, {
      epoch: 0,
      disposition: "allow",
    });
    expect(stale).toEqual({ ok: false, code: "stale_epoch" });
    expect(E.state).toBe("running");

    // Clear bind → also stale
    orchestrator.clearBind(E);
    const missingBind = orchestrator.settleSurface(E, {
      epoch: 1,
      disposition: "deny",
    });
    expect(missingBind).toEqual({ ok: false, code: "stale_epoch" });
    expect(E.state).toBe("running");
  });

  it("T21: settleSurface not_running", () => {
    const { orchestrator, E } = makeOrch({
      actors: [["test.tool", def("surface")]],
      modules: { surface: () => {} },
    });
    expect(E.state).toBe("declared");
    const result = orchestrator.settleSurface(E, {
      epoch: 0,
      disposition: "allow",
    });
    expect(result).toEqual({ ok: false, code: "not_running" });
  });

  it("T10: unexpected death → awaiting_rebind → activate ≤ MAX", () => {
    let starts = 0;
    const { orchestrator, E } = makeOrch({
      start: () => {
        starts += 1;
        // leave running
      },
    });

    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(starts).toBe(1);
    expect(E.rebindCount).toBe(0);
    const signal1 = orchestrator.binding.get(E)!.handle!;

    orchestrator.onResolverDeath(E, "process_exit");
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(1);
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(signal1.aborted).toBe(true);

    // Re-activate (A2) — under budget
    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(starts).toBe(2);
    expect(E.bindEpoch).toBe(2);
    expect(E.rebindCount).toBe(1);

    // Multiple deaths within MAX still re-activate
    for (let i = 0; i < DEFAULT_MAX_REBINDS - 1; i++) {
      orchestrator.onResolverDeath(E);
      expect(E.state).toBe("awaiting_rebind");
      orchestrator.activate(E);
      expect(E.state).toBe("running");
    }
    expect(E.rebindCount).toBe(DEFAULT_MAX_REBINDS);
    expect(starts).toBe(1 + DEFAULT_MAX_REBINDS);
  });

  it("T17: rebindCount > MAX → failed on activate", () => {
    const { orchestrator, E } = makeOrch({
      start: () => {
        /* leave running */
      },
      maxRebinds: 3,
    });

    orchestrator.activate(E);
    // Drive rebindCount past MAX
    for (let i = 0; i < 4; i++) {
      orchestrator.onResolverDeath(E);
      if (E.rebindCount <= 3) {
        orchestrator.activate(E);
        expect(E.state).toBe("running");
      }
    }
    expect(E.rebindCount).toBe(4);
    expect(E.state).toBe("awaiting_rebind");

    orchestrator.activate(E);
    expect(E.state).toBe("failed");
    expect(orchestrator.binding.has(E)).toBe(false);
  });

  it("T20: lease yield aborts then awaiting_rebind; rebindCount unchanged", () => {
    let abortedBeforeState = false;
    let stateWhenAborted: string | undefined;

    const { orchestrator, E } = makeOrch({
      start: (input) => {
        input.signal.addEventListener("abort", () => {
          stateWhenAborted = E.state;
          abortedBeforeState = E.state === "running";
        });
      },
    });

    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(E.rebindCount).toBe(0);
    const handle = orchestrator.binding.get(E)!.handle!;

    orchestrator.disposeLease("lease_yield");

    expect(abortedBeforeState).toBe(true);
    expect(stateWhenAborted).toBe("running");
    expect(handle.aborted).toBe(true);
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(0); // unchanged — T20
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(orchestrator.activating.has(E)).toBe(false);

    // Can re-activate after handover
    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(E.rebindCount).toBe(0);
  });

  it("T14: missing → plan added → reconcile activate → running", () => {
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map(), // no plan yet
      }),
      openWork: [new TestExpectation()],
    });
    const E = forest.openWork[0]!;

    const orchestrator = new Orchestrator({
      getOrchestration: () => forest.orchestration,
      loadedModules: new Set(["inprocess", "surface"]),
      modules: modulesFromRecord({
        inprocess: () => {
          /* leave running */
        },
      }),
      getOpenWorkRoots: () => forest.openWork,
    });

    orchestrator.activate(E);
    expect(E.state).toBe("missing");

    // Plan added (A3-style) — replace actors map entry
    forest.orchestration.actors = new Map([["test.tool", def("inprocess")]]);

    orchestrator.reconcile();
    expect(E.state).toBe("running");
    expect(orchestrator.binding.has(E)).toBe(true);
  });

  it("T22: reconcile cancelTree on tree orphan", () => {
    const child = new TestExpectation();
    const parent = new TestExpectation({ children: [child] });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def("inprocess")]]),
      }),
      openWork: [parent],
    });

    let childAborted = false;
    const orchestrator = new Orchestrator({
      getOrchestration: () => forest.orchestration,
      loadedModules: new Set(["inprocess"]),
      modules: modulesFromRecord({
        inprocess: (input) => {
          input.signal.addEventListener("abort", () => {
            childAborted = true;
          });
        },
      }),
      getOpenWorkRoots: () => forest.openWork,
    });

    orchestrator.activate(parent);
    orchestrator.activate(child);
    expect(parent.state).toBe("running");
    expect(child.state).toBe("running");

    // Simulate half-landed parent terminal without cascade (repair case)
    parent.transitionState("sealed");
    orchestrator.clearBind(parent);
    // child still running under terminal parent = tree orphan

    orchestrator.reconcile();

    expect(child.state).toBe("cancelled");
    expect(childAborted).toBe(true);
    expect(orchestrator.binding.has(child)).toBe(false);
  });

  it("T27: forest orphan → cancelled (not rebind)", () => {
    const orphan = new TestExpectation();
    // orphan is NOT under openWork — simulated forest orphan candidate
    const E = new TestExpectation();
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", def("inprocess")]]),
      }),
      openWork: [E],
    });

    let orphanAborted = false;
    const orchestrator = new Orchestrator({
      getOrchestration: () => forest.orchestration,
      loadedModules: new Set(["inprocess"]),
      modules: modulesFromRecord({
        inprocess: () => {
          /* leave running */
        },
      }),
      getOpenWorkRoots: () => forest.openWork,
      walkCandidates: () => [E, orphan],
    });

    // In-forest unit stays live
    orchestrator.activate(E);
    // Orphan: running with a bind but not reachable from openWork
    orphan.transitionState("running");
    orphan.bindEpoch = 1;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      orphanAborted = true;
    });
    orchestrator.setBind(orphan, {
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
    expect(forest.openWork.includes(orphan)).toBe(false);

    orchestrator.reconcile();

    expect(orphan.state).toBe("cancelled"); // not awaiting_rebind
    expect(orphan.rebindCount).toBe(0);
    expect(orphanAborted).toBe(true);
    expect(orchestrator.binding.has(orphan)).toBe(false);
    // In-forest unit still fine
    expect(E.state).toBe("running");
  });

  it("claim orphan via reconcile → awaiting_rebind (lease class) then re-activate", () => {
    const { orchestrator, E } = makeOrch({
      start: () => {
        /* leave running */
      },
    });
    orchestrator.activate(E);
    expect(E.state).toBe("running");
    const epochBefore = E.bindEpoch;
    orchestrator.clearBind(E); // claim orphan: running, no local bind

    // Step 2 only path: markAwaitingRebind without full reconcile activate
    orchestrator.markAwaitingRebind(E, {
      reason: "claim_orphan",
      incrementRebind: false,
    });
    expect(E.state).toBe("awaiting_rebind");
    expect(E.rebindCount).toBe(0); // lease class — no burn

    // Full reconcile would also activate; explicit activate matches A2
    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(E.rebindCount).toBe(0);
    expect(E.bindEpoch).toBe(epochBefore + 1);
    expect(orchestrator.binding.has(E)).toBe(true);
  });
});
