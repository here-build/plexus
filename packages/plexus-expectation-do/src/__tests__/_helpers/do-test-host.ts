/**
 * Minimal triad + host builder for the DO host matrix (mirrors
 * `@here.build/plexus-expectation`'s own `src/__tests__/_helpers/test-host.ts`
 * pattern: one forest-shaped doc, a scripted actor, a settable loader — but
 * split across TWO real Y.Docs per the proposal's two-doc topology (§1): a
 * SESSION doc (the Expectation tree) and a KERNEL doc (the LaunchDefinition
 * registry, `Orchestration` reused directly since its `plans` map already IS
 * the launcher home's expected shape).
 */
import invariant from "tiny-invariant";

import { Plexus, PlexusModel, syncing } from "@here.build/plexus";
import {
  Expectation,
  InProcessLaunchDefinition,
  LaunchDefinition,
  Orchestration,
} from "@here.build/plexus-expectation";
import { ExpectationActor, ExpectationLoader, type LaunchContext } from "@here.build/plexus-expectation/executor";
import * as Y from "yjs";

import { DurableObjectLoader, type ActorDoNamespacePort } from "../../actor-do-loader.js";
import { InProcessLoader, type DoLaunchContext } from "../../in-process-loader.js";
import { type AlarmPort, type InstallOpts, type StoragePort } from "../../ports.js";

export type DoTestResult = { readonly value?: string };
export type DoTestReport = { readonly note?: string } | Record<string, unknown>;

@syncing("do-test:DoTestExpectation")
export class DoTestExpectation extends Expectation<DoTestResult, DoTestReport> {
  static override readonly kind: string = "do.test.unit";

  /**
   * Doubles as the script-dispatch key (see {@link DispatchingDoLoader}): set
   * once at declare-time, read once at spawn-time via `snapshotInput()` — a
   * per-entity value, so concurrently-declared entities never race a shared
   * mutable loader field.
   */
  @syncing accessor payload: string = "";

  override snapshotInput(): unknown {
    return { payload: this.payload };
  }
}

@syncing("do-test:DoSessionRoot")
export class DoSessionRoot extends PlexusModel {
  /** The SESSION doc's declared work-roots list — `InstallOpts#root`'s expected `openWork` shape. */
  @syncing.child.list accessor openWork: Expectation[] = [];
}

/** Trivial durable plan for `DoRelayExpectation` — no config needed for the matrix's relay rows. */
@syncing("do-test:RelayLaunchDefinition")
export class RelayLaunchDefinition extends LaunchDefinition {}

/**
 * A DO-relayed triad's Expectation. `snapshotInput` MUST include the uuid:
 * the relay loader's spawn method has no other way to learn which
 * Expectation it is spawning for — `LaunchContext` carries no uuid field of
 * its own (see the loader's file preamble for the filled contract gap).
 */
@syncing("do-test:DoRelayExpectation")
export class DoRelayExpectation extends Expectation<DoTestResult, DoTestReport> {
  static override readonly kind: string = "do.test.relay";

  override snapshotInput(): unknown {
    return { uuid: this.uuid };
  }
}

/** Trivial durable plan for `DeclaringDoExpectation` — the declare-port/presence matrix rows' loop-actor stand-in. */
@syncing("do-test:DeclaringLaunchDefinition")
export class DeclaringLaunchDefinition extends LaunchDefinition {}

/**
 * A declare-port-capable triad's Expectation. `snapshotInput` MUST include
 * the uuid (`InProcessLoader`'s filled contract gap — see its file preamble):
 * the declare port closes over the REQUESTING entity's uuid so the host-side
 * mint (`DoOrchestrator#mintDeclaredChild`) knows which parent to home the
 * child under.
 */
@syncing("do-test:DeclaringDoExpectation")
export class DeclaringDoExpectation extends Expectation<DoTestResult, DoTestReport> {
  static override readonly kind: string = "do.test.declaring";

  /** Script-dispatch key, same pattern as `DoTestExpectation#payload`. */
  @syncing accessor payload: string = "";

  override snapshotInput(): unknown {
    return { uuid: this.uuid, payload: this.payload };
  }
}

export type DeclaringDoActorScript = (actor: DeclaringDoActor, ctx: DoLaunchContext) => void | Promise<void>;

export class DeclaringDoActor extends ExpectationActor<unknown, DoTestResult, DoTestReport> {
  constructor(private readonly script: DeclaringDoActorScript | undefined) {
    super();
  }

  protected run(ctx: LaunchContext): void | Promise<void> {
    // `InProcessLoader#spawn` always hands `createDoActor`/`start` the
    // declare/presence-augmented context — this cast is that contract, not a
    // guess.
    return this.script?.(this, ctx as DoLaunchContext);
  }

  doReport(frame: DoTestReport): void {
    this.report(frame);
  }

  doComplete(result: DoTestResult): void {
    this.complete(result);
  }

  doFail(reason: unknown): void {
    this.fail(reason);
  }
}

/** One loader instance serves every `DeclaringDoExpectation`, dispatching by `payload` (mirrors `DispatchingDoLoader`). */
export class DeclaringDoLoader extends InProcessLoader<unknown> {
  loadCalls = 0;
  spawnCalls = 0;
  readonly scripts = new Map<string, DeclaringDoActorScript>();

  async load(): Promise<void> {
    this.loadCalls += 1;
  }

  protected createDoActor(ctx: DoLaunchContext): ExpectationActor<unknown, unknown, unknown> {
    this.spawnCalls += 1;
    const input = ctx.input as { readonly payload?: string };
    const script = input.payload ? this.scripts.get(input.payload) : undefined;
    return new DeclaringDoActor(script) as ExpectationActor<unknown, unknown, unknown>;
  }
}

export type DoActorScript = (actor: ScriptedDoActor, ctx: LaunchContext) => void | Promise<void>;

export class ScriptedDoActor extends ExpectationActor<unknown, DoTestResult, DoTestReport> {
  constructor(private readonly script: DoActorScript | undefined) {
    super();
  }

  protected run(ctx: LaunchContext): void | Promise<void> {
    return this.script?.(this, ctx);
  }

  doReport(frame: DoTestReport): void {
    this.report(frame);
  }

  doComplete(result: DoTestResult): void {
    this.complete(result);
  }

  doFail(reason: unknown): void {
    this.fail(reason);
  }
}

/**
 * One loader instance serves every `DoTestExpectation`, dispatching to a
 * per-entity script by the entity's own `payload` (read from `ctx.input`,
 * snapshotted at THIS entity's spawn) rather than a loader-wide mutable
 * field — so declaring entity B before entity A has spawned can never change
 * which script A's actor runs.
 */
export class DispatchingDoLoader extends ExpectationLoader {
  loadCalls = 0;
  spawnCalls = 0;
  readonly scripts = new Map<string, DoActorScript>();

  async load(): Promise<void> {
    this.loadCalls += 1;
  }

  protected createActor(ctx: LaunchContext): ExpectationActor<unknown, unknown, unknown> {
    this.spawnCalls += 1;
    const input = ctx.input as { readonly payload?: string };
    const script = input.payload ? this.scripts.get(input.payload) : undefined;
    return new ScriptedDoActor(script) as ExpectationActor<unknown, unknown, unknown>;
  }
}

export type DoTestHost = {
  readonly opts: InstallOpts;
  readonly storage: StoragePort & { readonly log: Array<{ key: string; value: unknown }> };
  readonly alarms: AlarmPort & { fire(): void; readonly setAt: number[] };
  readonly retained: Promise<unknown>[];
  /** Presence mint log (proposal §8 G10) — clientIDs in mint order, one entry per `mintClient()` call. */
  readonly presenceMints: readonly number[];
  readonly presenceReports: readonly { readonly clientID: number; readonly frame: unknown }[];
  /** Presence destroy log — clientIDs in destroy order. */
  readonly presenceDestroyed: readonly number[];
  readonly sessionRoot: DoSessionRoot;
  readonly launcherRoot: Orchestration;
  readonly loader: DispatchingDoLoader;
  /** Set only when `freshDoHost` was given a relay namespace. */
  readonly relayLoader: DurableObjectLoader | undefined;
  /** `InProcessLoader`-based loader backing `declareDeclaring` — declare-port/presence matrix rows (proposal §7 G15/G16, §8). */
  readonly declaringLoader: DeclaringDoLoader;
  /** Mint + push a declared `DoTestExpectation`, scripted by `script` (undefined = a hanging actor that never settles). */
  declare(script?: DoActorScript): DoTestExpectation;
  /** Mint + push a declared `DoRelayExpectation` — requires `freshDoHost(relayNs)`. */
  declareRelay(): DoRelayExpectation;
  /** Mint + push a declared `DeclaringDoExpectation` — its actor gets `ctx.declare`/`ctx.presence` via `InProcessLoader`. */
  declareDeclaring(script?: DeclaringDoActorScript): DeclaringDoExpectation;
};

function fakeStorage(): DoTestHost["storage"] {
  const map = new Map<string, unknown>();
  const log: Array<{ key: string; value: unknown }> = [];
  return {
    log,
    put(key, value) {
      map.set(key, value);
      log.push({ key, value });
    },
    get: (key) => map.get(key),
    delete(key) {
      map.delete(key);
    },
  };
}

function fakeAlarms(): DoTestHost["alarms"] {
  const setAt: number[] = [];
  let cb: (() => void) | null = null;
  return {
    setAt,
    set(at) {
      setAt.push(at);
    },
    onFire(f) {
      cb = f;
    },
    fire() {
      cb?.();
    },
  };
}

/**
 * @param relayNs When given, wires the relay Expectation's plan to a
 * `DurableObjectLoader` over this namespace and enables `declareRelay()`.
 * Omitted by every Stage 1 test — those keep the exact prior behavior.
 */
export function freshDoHost(relayNs?: ActorDoNamespacePort): DoTestHost {
  const sessionDoc = new Y.Doc();
  const sessionRoot = new DoSessionRoot();
  Plexus.bootstrap(sessionRoot, undefined, sessionDoc);

  const kernelDoc = new Y.Doc();
  const launcherRoot = new Orchestration();
  Plexus.bootstrap(launcherRoot, undefined, kernelDoc);

  const loader = new DispatchingDoLoader();
  launcherRoot.plans.set(DoTestExpectation.kind, new InProcessLaunchDefinition());

  const declaringLoader = new DeclaringDoLoader();
  launcherRoot.plans.set(DeclaringDoExpectation.kind, new DeclaringLaunchDefinition());

  const storage = fakeStorage();
  const alarms = fakeAlarms();
  const retained: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>): void => {
    retained.push(p);
    p.catch(() => {});
  };
  // Observable presence fake (proposal §8 G10): every mint/report/destroy is
  // logged so presence-focused rows can assert the ordering and lifecycle
  // claims (clientID obtained before the `processorClientId` write; destroy
  // at fold) without needing `vi.fn()` — plain arrays suffice and stay
  // inspectable from `DoTestHost`.
  let nextClient = 1;
  const presenceMints: number[] = [];
  const presenceReports: Array<{ readonly clientID: number; readonly frame: unknown }> = [];
  const presenceDestroyed: number[] = [];
  const presence = {
    mintClient: () => {
      const clientID = nextClient++;
      presenceMints.push(clientID);
      return {
        clientID,
        setReport: (frame: unknown) => presenceReports.push({ clientID, frame }),
        destroy: () => presenceDestroyed.push(clientID),
      };
    },
  };

  const loaders = new Map<abstract new (...args: never[]) => unknown, unknown>([
    [InProcessLaunchDefinition, loader],
    [DeclaringLaunchDefinition, declaringLoader],
  ]);
  let relayLoader: DurableObjectLoader | undefined;
  if (relayNs) {
    relayLoader = new DurableObjectLoader(relayNs, waitUntil);
    loaders.set(RelayLaunchDefinition, relayLoader);
    launcherRoot.plans.set(DoRelayExpectation.kind, new RelayLaunchDefinition());
  }

  // Declare-port kind → Expectation factory (proposal §7 G15/G16 filled gap):
  // the matrix rows declare a `DoTestExpectation` CHILD under a
  // `DeclaringDoExpectation` PARENT — reusing the already-registered kind
  // means the minted child could, in principle, activate through the SAME
  // `DispatchingDoLoader` plan the top-level `declare()` rows use.
  const childFactories = new Map<string, () => Expectation>([[DoTestExpectation.kind, () => new DoTestExpectation()]]);

  const opts: InstallOpts = {
    root: sessionRoot,
    launchers: launcherRoot,
    storage,
    alarms,
    waitUntil,
    presence,
    loaders,
    childFactories,
  };

  let nextDeclareId = 1;
  return {
    opts,
    storage,
    alarms,
    retained,
    presenceMints,
    presenceReports,
    presenceDestroyed,
    sessionRoot,
    launcherRoot,
    loader,
    relayLoader,
    declaringLoader,
    declare(script) {
      const entity = new DoTestExpectation();
      const key = `do-${nextDeclareId++}`;
      entity.payload = key;
      if (script) loader.scripts.set(key, script);
      sessionRoot.openWork.push(entity);
      return entity;
    },
    declareRelay() {
      invariant(relayLoader, "freshDoHost(relayNs) must be given a relay namespace to use declareRelay()");
      const entity = new DoRelayExpectation();
      sessionRoot.openWork.push(entity);
      return entity;
    },
    declareDeclaring(script) {
      const entity = new DeclaringDoExpectation();
      const key = `declaring-${nextDeclareId++}`;
      entity.payload = key;
      if (script) declaringLoader.scripts.set(key, script);
      sessionRoot.openWork.push(entity);
      return entity;
    },
  };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
