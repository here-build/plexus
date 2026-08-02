import { Plexus, PlexusAwareness, PlexusModel, syncing } from "@here.build/plexus";
import * as Y from "yjs";

import {
  ExpectationActor,
  ExpectationLoader,
  Orchestrator,
  type KernelPresenceStatus,
  type LaunchContext,
} from "../../executor/index.js";
import { Expectation, Orchestration, type IntentRecord, type LaunchDefinition } from "../../shared/index.js";
import { InProcessLaunchDefinition } from "../../shared/models/index.js";

/** Minimal triad + host for kernel tests. One forest model, scripted actors, a settable loader. */

export type TestResult = { value?: string };
export type TestReport = { note?: string } | Record<string, unknown>;

@syncing("test:PewExpectation")
export class TestExpectation extends Expectation<TestResult, TestReport> {
  static override readonly kind: string = "test.unit";

  @syncing accessor payload: string = "";
  @syncing accessor resultValue: string = "";

  override snapshotInput(): unknown {
    return { payload: this.payload };
  }

  override applySettlement(result: TestResult): void {
    this.resultValue = result.value ?? "";
  }
}

@syncing("test:ThrowingExpectation")
export class ThrowingExpectation extends TestExpectation {
  static override readonly kind: string = "test.throwing";

  override applySettlement(result: TestResult): void {
    this.resultValue = result.value ?? "";
    throw new Error("apply boom");
  }
}

@syncing("test:SurfaceExpectation")
export class SurfaceExpectation extends Expectation<never, never> {
  static override readonly kind: string = "test.surface";
}

@syncing("test:PewMessagesDefinition")
export class TestMessagesDefinition extends InProcessLaunchDefinition {
  static override readonly acceptsMessages: boolean = true;
}

@syncing("test:PewForest")
export class PewForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: Expectation[] = [];
}

export type ActorScript = (actor: ScriptedActor, ctx: LaunchContext) => void | Promise<void>;

export class ScriptedActor extends ExpectationActor<unknown, TestResult, TestReport> {
  constructor(private readonly script: ActorScript | undefined) {
    super();
  }

  protected run(ctx: LaunchContext): void | Promise<void> {
    return this.script?.(this, ctx);
  }

  doReport(frame: TestReport): void {
    this.report(frame);
  }

  doComplete(result: TestResult): void {
    this.complete(result);
  }

  doFail(reason: unknown): void {
    this.fail(reason);
  }

  doOutcome(intentId: string, outcome: "considered" | "dropped"): void {
    this.outcome(intentId, outcome);
  }
}

export class TestLoader extends ExpectationLoader {
  loadCalls = 0;
  spawnCalls = 0;
  failLoad: unknown = null;
  script: ActorScript | undefined;
  lastActor: ScriptedActor | null = null;
  onSpawn: ((ctx: LaunchContext) => void) | null = null;

  constructor(script?: ActorScript) {
    super();
    this.script = script;
  }

  async load(): Promise<void> {
    this.loadCalls += 1;
    if (this.failLoad !== null) throw this.failLoad;
  }

  protected createActor(ctx: LaunchContext): ExpectationActor<unknown, unknown, unknown> {
    this.spawnCalls += 1;
    this.onSpawn?.(ctx);
    const actor = new ScriptedActor(this.script);
    this.lastActor = actor;
    return actor as ExpectationActor<unknown, unknown, unknown>;
  }
}

export class ThrowingSpawnLoader extends TestLoader {
  protected override createActor(): ExpectationActor<unknown, unknown, unknown> {
    this.spawnCalls += 1;
    throw new Error("spawn boom");
  }
}

export type PewTestHostOptions = {
  readonly claimOwner?: boolean;
  readonly hub?: boolean;
};

export class PewTestHost extends Orchestrator {
  readonly doc: Y.Doc;
  readonly forest: PewForest;
  readonly awareness: PlexusAwareness | null;
  readonly loaders = new Map<unknown, ExpectationLoader>();
  claimOwner: boolean;
  peerBinds = new Set<string>();
  authorIntents: IntentRecord[] = [];
  published: KernelPresenceStatus[] = [];
  candidates: Expectation[] = [];

  constructor(options: PewTestHostOptions = {}) {
    super();
    this.doc = new Y.Doc();
    this.forest = new PewForest();
    Plexus.bootstrap(this.forest, undefined, this.doc);
    this.awareness = (options.hub ?? true) ? new PlexusAwareness(this.doc) : null;
    this.claimOwner = options.claimOwner ?? true;
  }

  dispose(): void {
    this.doc.destroy();
  }

  /** Register plan + loader for a kind in one call. */
  plan(kind: string, def: LaunchDefinition, loader: ExpectationLoader | null): void {
    this.forest.orchestration.plans.set(kind, def);
    if (loader) this.loaders.set(def.constructor, loader);
  }

  mint<E extends Expectation>(entity: E): E {
    this.forest.openWork.push(entity);
    return entity;
  }

  getOrchestration(): Orchestration {
    return this.forest.orchestration;
  }

  getLoader(def: LaunchDefinition): ExpectationLoader | undefined {
    return this.loaders.get(def.constructor);
  }

  isClaimOwner(): boolean {
    return this.claimOwner;
  }

  getOpenWorkRoots(): readonly Expectation[] {
    return this.forest.openWork;
  }

  walkCandidates(): Iterable<Expectation> {
    return this.candidates;
  }

  hasLiveClaimPeerBind(E: Expectation): boolean {
    return this.peerBinds.has(E.uuid);
  }

  getPresenceHub(): PlexusAwareness | null {
    return this.awareness;
  }

  publishKernelPresence(status: KernelPresenceStatus): void {
    this.published.push(status);
  }

  override getAuthorIntents(): readonly IntentRecord[] {
    return this.authorIntents;
  }

  lastPublished(): KernelPresenceStatus | undefined {
    return this.published.at(-1);
  }
}

/** Default wiring: one test kind, messages-accepting definition, scripted loader. */
export function makeHost(
  script?: ActorScript,
  options: PewTestHostOptions & { kind?: string } = {},
): { host: PewTestHost; loader: TestLoader; dispose: () => void } {
  const host = new PewTestHost(options);
  const loader = new TestLoader(script);
  host.plan(options.kind ?? TestExpectation.kind, new TestMessagesDefinition(), loader);
  return { host, loader, dispose: () => host.dispose() };
}

/** Activate through the load handshake: first reconcile kicks load, flush, second activates. */
export async function activateThroughLoad(host: PewTestHost): Promise<void> {
  host.reconcile();
  await Promise.resolve();
  await Promise.resolve();
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export { SurfaceLaunchDefinition } from "../../shared/models/index.js";
