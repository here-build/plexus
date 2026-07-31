/**
 * PR-3 runtime: activate + emit (T1–T5, T9, T16, T19, T24, T25).
 */
import "@here.build/plexus/mobx/register";

import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Expectation } from "../app/index.js";
import { LaunchDefinition, Orchestration } from "../orchestration/index.js";
import {
  modulesFromRecord,
  Orchestrator,
  type ModuleRegistry,
  type ResolverStartInput,
  type StartResolverFn,
} from "../runtime/index.js";

function asModules(m: ModuleRegistry | Record<string, StartResolverFn>): ModuleRegistry {
  if (typeof (m as ModuleRegistry).register === "function") {
    return m as ModuleRegistry;
  }
  return modulesFromRecord(m as Record<string, StartResolverFn>);
}

@syncing("@here.build/plexus-expectation:test.RuntimeExpectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.tool";

  @syncing accessor payload: string = "";
}

@syncing("@here.build/plexus-expectation:test.RuntimeForest")
class TestForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: TestExpectation[] = [];
}

function def(mode: "inprocess" | "surface" = "inprocess"): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: mode,
    acceptsMessages: false,
    emitsProgress: true,
    progressMode: "lww",
  });
}

function makeOrch(opts: {
  actors?: ReadonlyArray<readonly [string, LaunchDefinition]>;
  loaded?: ReadonlySet<string>;
  start?: StartResolverFn;
  modules?: ModuleRegistry | Record<string, StartResolverFn>;
  applyProgress?: (E: Expectation, patch: unknown) => void;
  snapshotProductFields?: (E: Expectation) => unknown;
}): {
  forest: TestForest;
  orchestrator: Orchestrator;
  E: TestExpectation;
} {
  const launch = def("inprocess");
  const actors = opts.actors ?? [["test.tool", launch]];
  const E = new TestExpectation({ payload: "in" });
  const forest = new TestForest({
    orchestration: new Orchestration({
      actors: new Map(actors),
    }),
    openWork: [E],
  });

  const modules = asModules(
    opts.modules ??
      (opts.start
        ? { inprocess: opts.start }
        : {
            inprocess: ((_input, emit) => {
              emit({ type: "complete", epoch: _input.epoch });
            }) satisfies StartResolverFn,
          }),
  );

  const orchestrator = new Orchestrator({
    getOrchestration: () => forest.orchestration,
    loadedModules: opts.loaded ?? new Set(["inprocess", "surface"]),
    modules,
    applyProgress: opts.applyProgress,
    snapshotProductFields:
      opts.snapshotProductFields ??
      ((e) => ({ payload: (e as TestExpectation).payload })),
  });

  return { forest, orchestrator, E };
}

describe("runtime activate / emit", () => {
  beforeEach(() => resetLocalIDs());

  it("T1: no plan → missing via activate", () => {
    const { orchestrator, E } = makeOrch({ actors: [] });
    orchestrator.activate(E);
    expect(E.state).toBe("missing");
    expect(orchestrator.binding.has(E)).toBe(false);
  });

  it("T2: unloaded mode → refused via activate", () => {
    const { orchestrator, E } = makeOrch({
      loaded: new Set(["surface"]), // inprocess plan, surface only loaded
    });
    orchestrator.activate(E);
    expect(E.state).toBe("refused");
    expect(orchestrator.binding.has(E)).toBe(false);
  });

  it("T3: inprocess progress + complete", () => {
    const patches: unknown[] = [];
    const { orchestrator, E } = makeOrch({
      applyProgress: (_e, patch) => {
        patches.push(patch);
      },
      start: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { n: 1 } });
        emit({ type: "progress", epoch: input.epoch, patch: { n: 2 } });
        emit({ type: "complete", epoch: input.epoch });
      },
    });
    orchestrator.activate(E);
    expect(patches).toEqual([{ n: 1 }, { n: 2 }]);
    expect(E.state).toBe("sealed");
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(E.bindEpoch).toBe(1);
  });

  it("T4: stale epoch emit dropped", () => {
    const patches: unknown[] = [];
    let captured: { emit: Parameters<StartResolverFn>[1]; epoch: number } | undefined;
    const { orchestrator, E } = makeOrch({
      applyProgress: (_e, patch) => {
        patches.push(patch);
      },
      start: (input, emit) => {
        captured = { emit, epoch: input.epoch };
        // leave running — do not complete
      },
    });
    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(1);

    // Stale epoch
    captured!.emit({ type: "progress", epoch: 0, patch: { stale: true } });
    captured!.emit({ type: "complete", epoch: 0 });
    expect(patches).toEqual([]);
    expect(E.state).toBe("running");

    // Current epoch still works
    captured!.emit({ type: "progress", epoch: 1, patch: { ok: true } });
    expect(patches).toEqual([{ ok: true }]);
    captured!.emit({ type: "complete", epoch: 1 });
    expect(E.state).toBe("sealed");
  });

  it("T5 / T24: activation single-flight (concurrent activate)", () => {
    let entries = 0;
    let reentrantActivate = 0;
    const { orchestrator, E } = makeOrch({
      start: (input, emit) => {
        entries += 1;
        // Nested activate while in activating set
        orchestrator.activate(E);
        if (orchestrator.activating.has(E)) {
          reentrantActivate += 1;
        }
        // Second external-style call
        orchestrator.activate(E);
        emit({ type: "complete", epoch: input.epoch });
      },
    });
    orchestrator.activate(E);
    expect(entries).toBe(1);
    expect(reentrantActivate).toBe(1);
    expect(E.state).toBe("sealed");
    // Healthy sealed: further activate is no-op
    orchestrator.activate(E);
    expect(entries).toBe(1);
  });

  it("T9: resolver gets snapshot only — no Expectation entity / doc", () => {
    let seen: ResolverStartInput | undefined;
    const { orchestrator, E } = makeOrch({
      snapshotProductFields: (e) => ({ payload: (e as TestExpectation).payload }),
      start: (input, emit) => {
        seen = input;
        // Prove input is plain data
        const json = JSON.parse(JSON.stringify(input)) as ResolverStartInput;
        expect(json.work.kind).toBe("test.tool");
        expect(json.epoch).toBe(1);
        expect(json.definition.launchMode).toBe("inprocess");
        expect(json.input).toEqual({ payload: "in" });
        expect(input.signal).toBeInstanceOf(AbortSignal);
        emit({ type: "complete", epoch: input.epoch });
      },
    });
    orchestrator.activate(E);
    expect(seen).toBeDefined();
    // No Expectation / doc keys on the start payload
    expect(seen).not.toHaveProperty("expectation");
    expect(seen).not.toHaveProperty("doc");
    expect(seen).not.toHaveProperty("E");
    // Values are snapshots, not live entity references
    expect(seen!.input).toEqual({ payload: "in" });
    expect(seen!.input).not.toBe(E);
  });

  it("T16: startResolver throw → failed, epoch burned", () => {
    const { orchestrator, E } = makeOrch({
      start: () => {
        throw new Error("boom");
      },
    });
    orchestrator.activate(E);
    expect(E.state).toBe("failed");
    expect(E.bindEpoch).toBe(1); // burned, not rolled back
    expect(orchestrator.binding.has(E)).toBe(false);
  });

  it("T19: sync complete before startResolver returns is applied", () => {
    let stateAtReturn: string | undefined;
    const { orchestrator, E } = makeOrch({
      start: (input, emit) => {
        emit({ type: "complete", epoch: input.epoch });
        // Observe from inside: already sealed before return
        stateAtReturn = E.state;
      },
    });
    orchestrator.activate(E);
    expect(stateAtReturn).toBe("sealed");
    expect(E.state).toBe("sealed");
    expect(orchestrator.binding.has(E)).toBe(false);
  });

  it("T25: binding/activating use entity keys (not uuid strings)", () => {
    let midBindKeys: unknown[] = [];
    let midActivatingHasEntity = false;
    const { orchestrator, E } = makeOrch({
      start: (input, emit) => {
        midBindKeys = [...orchestrator.binding.keys()];
        midActivatingHasEntity = orchestrator.activating.has(E);
        expect(orchestrator.binding.has(E)).toBe(true);
        // Map must not be keyed by uuid string
        for (const k of midBindKeys) {
          expect(typeof k).not.toBe("string");
          expect(k).toBeInstanceOf(Expectation);
        }
        emit({ type: "complete", epoch: input.epoch });
      },
    });
    orchestrator.activate(E);
    expect(midActivatingHasEntity).toBe(true);
    expect(midBindKeys).toHaveLength(1);
    expect(midBindKeys[0]).toBe(E);
  });

  it("surface mode binds without startResolver", () => {
    const start = vi.fn();
    const { orchestrator, E } = makeOrch({
      actors: [["test.tool", def("surface")]],
      modules: modulesFromRecord({ inprocess: start, surface: start }),
    });
    orchestrator.activate(E);
    expect(E.state).toBe("running");
    expect(start).not.toHaveBeenCalled();
    expect(orchestrator.binding.has(E)).toBe(true);
    expect(orchestrator.binding.get(E)!.epoch).toBe(E.bindEpoch);
  });

  it("running + healthy bind is idempotent", () => {
    let starts = 0;
    const { orchestrator, E } = makeOrch({
      start: () => {
        starts += 1;
        // stay running
      },
    });
    orchestrator.activate(E);
    orchestrator.activate(E);
    expect(starts).toBe(1);
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(1);
  });

  it("fail emit → failed", () => {
    const { orchestrator, E } = makeOrch({
      start: (input, emit) => {
        emit({ type: "fail", epoch: input.epoch, reason: "x" });
      },
    });
    orchestrator.activate(E);
    expect(E.state).toBe("failed");
  });

  it("missing starter waits (no durable run); late register + noteModulesChanged activates", () => {
    const launch = def("inprocess");
    const E = new TestExpectation({ payload: "late" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch]]),
      }),
      openWork: [E],
    });
    const modules = modulesFromRecord({});
    const orchestrator = new Orchestrator({
      getOrchestration: () => forest.orchestration,
      loadedModules: new Set(["inprocess", "surface"]),
      modules,
      getOpenWorkRoots: () => forest.openWork,
      snapshotProductFields: (e) => ({ payload: (e as TestExpectation).payload }),
    });

    orchestrator.activate(E);
    // Mode loaded, plan present, handler missing — wait, do not fail or run.
    expect(E.state).toBe("declared");
    expect(orchestrator.binding.has(E)).toBe(false);
    expect(E.bindEpoch).toBe(0);

    modules.register("inprocess", (input, emit) => {
      emit({ type: "complete", epoch: input.epoch });
    });
    orchestrator.noteModulesChanged();

    expect(E.state).toBe("sealed");
    expect(E.bindEpoch).toBe(1);
  });
});
