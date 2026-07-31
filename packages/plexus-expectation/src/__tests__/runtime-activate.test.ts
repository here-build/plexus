/**
 * Runtime: activate + emit (T1–T5, T9, T16, T19, T24, T25).
 *
 * Each host is an Orchestrator subclass — no makeOrch options bag.
 */
import "@here.build/plexus/mobx/register";

import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Expectation } from "../app/index.js";
import { LaunchDefinition, Orchestration } from "../orchestration/index.js";
import {
  Orchestrator,
  type ProgressPatch,
  type ResolverStartInput,
  type StartResolverFn,
} from "../runtime/index.js";

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

function launch(mode: "inprocess" | "surface" = "inprocess"): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: mode,
    acceptsMessages: false,
    emitsProgress: true,
    progressMode: "lww",
  });
}

/** Default test claim-owner host. Scenario hosts subclass and override abstract policy. */
class ActivateHost extends Orchestrator {
  /** kind and/or launchMode → starter. */
  readonly starters: Map<string, StartResolverFn>;
  private readonly modes: ReadonlySet<string>;

  constructor(
    readonly forest: TestForest,
    starters: Record<string, StartResolverFn> = {},
    modes: ReadonlySet<string> = new Set(["inprocess", "surface"]),
  ) {
    super();
    this.starters = new Map(Object.entries(starters));
    this.modes = modes;
  }

  getOrchestration(): Orchestration {
    return this.forest.orchestration;
  }

  supportsLaunchMode(mode: string): boolean {
    return this.modes.has(mode);
  }

  resolveModule(kind: string, launchMode: string): StartResolverFn | undefined {
    return this.starters.get(kind) ?? this.starters.get(launchMode);
  }

  registerModule(key: string, start: StartResolverFn): void {
    this.starters.set(key, start);
  }

  isClaimOwner(): boolean {
    return true;
  }

  getOpenWorkRoots(): readonly Expectation[] {
    return this.forest.openWork;
  }

  walkCandidates(): Iterable<Expectation> {
    return [];
  }

  hasLiveClaimPeerBind(_E: Expectation): boolean {
    return false;
  }

  snapshotProductFields(E: Expectation): unknown {
    return { payload: (E as TestExpectation).payload };
  }

  applyProgress(_E: Expectation, _patch: ProgressPatch): void {}

  publishAwarenessBinds(): void {}
}

class ProgressHost extends ActivateHost {
  readonly patches: unknown[] = [];

  override applyProgress(_E: Expectation, patch: ProgressPatch): void {
    this.patches.push(patch);
  }
}

describe("runtime activate / emit", () => {
  beforeEach(() => resetLocalIDs());

  it("T1: no plan → missing via activate", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({ actors: new Map() }),
      openWork: [E],
    });
    const host = new ActivateHost(forest, {
      inprocess: (input, emit) => {
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(E.state).toBe("missing");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T2: unloaded mode → refused via activate", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    // Plan wants inprocess; host only loads surface.
    const host = new ActivateHost(
      forest,
      {
        inprocess: (input, emit) => {
          emit({ type: "complete", epoch: input.epoch });
        },
      },
      new Set(["surface"]),
    );

    host.activate(E);
    expect(E.state).toBe("refused");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T3: inprocess progress + complete", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    const host = new ProgressHost(forest, {
      inprocess: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { n: 1 } });
        emit({ type: "progress", epoch: input.epoch, patch: { n: 2 } });
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(host.patches).toEqual([{ n: 1 }, { n: 2 }]);
    expect(E.state).toBe("sealed");
    expect(host.binding.has(E)).toBe(false);
    expect(E.bindEpoch).toBe(1);
  });

  it("T4: stale epoch emit dropped", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    let captured: { emit: Parameters<StartResolverFn>[1]; epoch: number } | undefined;
    const host = new ProgressHost(forest, {
      inprocess: (input, emit) => {
        captured = { emit, epoch: input.epoch };
      },
    });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(1);

    captured!.emit({ type: "progress", epoch: 0, patch: { stale: true } });
    captured!.emit({ type: "complete", epoch: 0 });
    expect(host.patches).toEqual([]);
    expect(E.state).toBe("running");

    captured!.emit({ type: "progress", epoch: 1, patch: { ok: true } });
    expect(host.patches).toEqual([{ ok: true }]);
    captured!.emit({ type: "complete", epoch: 1 });
    expect(E.state).toBe("sealed");
  });

  it("T5 / T24: activation single-flight (concurrent activate)", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    let entries = 0;
    let reentrantActivate = 0;
    const host = new ActivateHost(forest, {
      inprocess: (input, emit) => {
        entries += 1;
        host.activate(E);
        if (host.activating.has(E)) reentrantActivate += 1;
        host.activate(E);
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(entries).toBe(1);
    expect(reentrantActivate).toBe(1);
    expect(E.state).toBe("sealed");
    host.activate(E);
    expect(entries).toBe(1);
  });

  it("T9: resolver gets snapshot only — no Expectation entity / doc", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    let seen: ResolverStartInput | undefined;
    const host = new ActivateHost(forest, {
      inprocess: (input, emit) => {
        seen = input;
        const json = JSON.parse(JSON.stringify(input)) as ResolverStartInput;
        expect(json.kind).toBe("test.tool");
        expect(json.epoch).toBe(1);
        expect(json.definition.launchMode).toBe("inprocess");
        expect(json.input).toEqual({ payload: "in" });
        expect(input.signal).toBeInstanceOf(AbortSignal);
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("expectation");
    expect(seen).not.toHaveProperty("doc");
    expect(seen).not.toHaveProperty("E");
    expect(seen!.input).toEqual({ payload: "in" });
    expect(seen!.input).not.toBe(E);
  });

  it("T16: startResolver throw → failed, epoch burned", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    const host = new ActivateHost(forest, {
      inprocess: () => {
        throw new Error("boom");
      },
    });

    host.activate(E);
    expect(E.state).toBe("failed");
    expect(E.bindEpoch).toBe(1);
    expect(host.binding.has(E)).toBe(false);
  });

  it("T19: sync complete before startResolver returns is applied", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    let stateAtReturn: string | undefined;
    const host = new ActivateHost(forest, {
      inprocess: (input, emit) => {
        emit({ type: "complete", epoch: input.epoch });
        stateAtReturn = E.state;
      },
    });

    host.activate(E);
    expect(stateAtReturn).toBe("sealed");
    expect(E.state).toBe("sealed");
    expect(host.binding.has(E)).toBe(false);
  });

  it("T25: binding/activating use entity keys (not uuid strings)", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    let midBindKeys: unknown[] = [];
    let midActivatingHasEntity = false;
    const host = new ActivateHost(forest, {
      inprocess: (input, emit) => {
        midBindKeys = [...host.binding.keys()];
        midActivatingHasEntity = host.activating.has(E);
        expect(host.binding.has(E)).toBe(true);
        for (const k of midBindKeys) {
          expect(typeof k).not.toBe("string");
          expect(k).toBeInstanceOf(Expectation);
        }
        emit({ type: "complete", epoch: input.epoch });
      },
    });

    host.activate(E);
    expect(midActivatingHasEntity).toBe(true);
    expect(midBindKeys).toHaveLength(1);
    expect(midBindKeys[0]).toBe(E);
  });

  it("surface mode uses mode-level starter (not inprocess)", () => {
    const inprocess = vi.fn();
    const surface = vi.fn(() => {
      /* leave running — human settle */
    });
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("surface")]]),
      }),
      openWork: [E],
    });
    const host = new ActivateHost(forest, { inprocess, surface });

    host.activate(E);
    expect(E.state).toBe("running");
    expect(inprocess).not.toHaveBeenCalled();
    expect(surface).toHaveBeenCalledOnce();
    expect(host.binding.has(E)).toBe(true);
    expect(host.binding.get(E)!.epoch).toBe(E.bindEpoch);
  });

  it("running + healthy bind is idempotent", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    let starts = 0;
    const host = new ActivateHost(forest, {
      inprocess: () => {
        starts += 1;
      },
    });

    host.activate(E);
    host.activate(E);
    expect(starts).toBe(1);
    expect(E.state).toBe("running");
    expect(E.bindEpoch).toBe(1);
  });

  it("fail emit → failed", () => {
    const E = new TestExpectation({ payload: "in" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    const host = new ActivateHost(forest, {
      inprocess: (input, emit) => {
        emit({ type: "fail", epoch: input.epoch, reason: "x" });
      },
    });

    host.activate(E);
    expect(E.state).toBe("failed");
  });

  it("missing starter waits (no durable run); late register + reconcile activates", () => {
    const E = new TestExpectation({ payload: "late" });
    const forest = new TestForest({
      orchestration: new Orchestration({
        actors: new Map([["test.tool", launch("inprocess")]]),
      }),
      openWork: [E],
    });
    const host = new ActivateHost(forest, {});

    host.activate(E);
    expect(E.state).toBe("declared");
    expect(host.binding.has(E)).toBe(false);
    expect(E.bindEpoch).toBe(0);

    host.registerModule("inprocess", (input, emit) => {
      emit({ type: "complete", epoch: input.epoch });
    });
    host.reconcile();

    expect(E.state).toBe("sealed");
    expect(E.bindEpoch).toBe(1);
  });
});
