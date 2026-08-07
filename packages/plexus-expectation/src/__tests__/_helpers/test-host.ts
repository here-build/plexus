import { Plexus, type PlexusAwareness, PlexusModel, syncing } from "@here.build/plexus";
import type * as Y from "yjs";

import {
  ExpectationActor,
  ExpectationLoader,
  Orchestrator,
  type CatalogPresenceStatus,
  type ClaimPresenceStatus,
  type LaunchContext,
} from "../../executor/index.js";
import { Expectation, Orchestration, PEW, type LaunchDefinition } from "../../shared/index.js";
import { InProcessLaunchDefinition } from "../../shared/models/index.js";

/** Minimal triad + host for kernel tests. One forest model, scripted actors, a settable loader. */

export type TestResult = { value?: string };
export type TestReport = { note?: string } | Record<string, unknown>;
export type TestSteer = { readonly note: string };

@syncing("test:PewExpectation")
export class TestExpectation extends Expectation<TestResult, TestReport, TestSteer> {
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

  override applySettlement(result: TestResult): void {
    this.resultValue = result.value ?? "";
    throw new Error("apply boom");
  }
}

@syncing("test:SurfaceExpectation")
export class SurfaceExpectation extends Expectation<never, never> {
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

export class ScriptedActor extends ExpectationActor<TestExpectation> {
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

}

export class TestLoader extends ExpectationLoader<TestExpectation> {
  override probeCapability?: () => Promise<import("../../executor/index.js").LoaderCapability>;
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

  protected createActor(ctx: LaunchContext): ExpectationActor<TestExpectation> {
    this.spawnCalls += 1;
    this.onSpawn?.(ctx);
    const actor = new ScriptedActor(this.script);
    this.lastActor = actor;
    return actor;
  }
}

export class ThrowingSpawnLoader extends TestLoader {
  protected override createActor(): ExpectationActor<TestExpectation> {
    this.spawnCalls += 1;
    throw new Error("spawn boom");
  }
}

export type PewTestHostOptions = {
  readonly claimOwner?: boolean;
  /** false → no PEW wire (inert clientId 0). */
  readonly hub?: boolean;
};

/** Claim-owner test host. Uses `plexus.awareness` — never a second hub on the same doc. */
export class PewTestHost extends Orchestrator {
  readonly doc: Y.Doc;
  readonly forest: PewForest;

  readonly plexus: Plexus<any>;
  readonly awareness: PlexusAwareness | null;
  readonly loaders = new Map<unknown, ExpectationLoader>();
  claimOwner: boolean;
  candidates: Expectation[] = [];
  readonly #hubEnabled: boolean;

  constructor(options: PewTestHostOptions = {}) {
    super();
    this.forest = new PewForest();
    this.plexus = Plexus.bootstrap(this.forest);
    this.doc = this.plexus.doc;
    this.#hubEnabled = options.hub ?? true;
    this.awareness = this.#hubEnabled ? this.plexus.awareness : null;
    this.claimOwner = options.claimOwner ?? true;
  }

  dispose(): void {
    this.plexus.destroy();
  }

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

  getSessionPlexus(): Plexus<any> | null {
    return this.#hubEnabled ? this.plexus : null;
  }

  protected override createPew(): PEW | null {
    return this.#hubEnabled ? new PEW({ kernel: this.plexus }) : null;
  }

  lastClaim(): ClaimPresenceStatus {
    return this.claimPresence();
  }

  lastCatalog(): CatalogPresenceStatus {
    return this.catalogPresence();
  }
}

export function makeHost(
  script?: ActorScript,
  options: PewTestHostOptions & { kind?: string } = {},
): { host: PewTestHost; loader: TestLoader; dispose: () => void } {
  const host = new PewTestHost(options);
  const loader = new TestLoader(script);
  host.plan(options.kind ?? TestExpectation.kind, new TestMessagesDefinition(), loader);
  return { host, loader, dispose: () => host.dispose() };
}

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
