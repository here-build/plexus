import type { ExpectationActor } from "./expectation-actor.js";
import type { ActorHandle, LaunchContext, LoaderCapability } from "./types.js";

/**
 * Hermetic spawn boundary for one LaunchDefinition class.
 *
 * `load()` holds all async work (idempotent). `spawn()` is synchronous —
 * it runs inside the activation critical section. Cross-process loaders
 * override spawn and return an adapter whose handle is kernel-side truth;
 * the runner must self-terminate when claim presence disappears.
 */
export abstract class ExpectationLoader<TInput = unknown, TCapabilityArgs = unknown> {
  abstract load(): Promise<void>;

  /**
   * Advisory inventory only — kernel publishes, never gates activation on it.
   */
  probeCapability?(): Promise<LoaderCapability<TCapabilityArgs>>;

  protected abstract createActor(ctx: LaunchContext<TInput>): ExpectationActor<TInput, unknown, unknown>;

  spawn(ctx: LaunchContext<TInput>): ActorHandle {
    const actor = this.createActor(ctx);
    actor.start(ctx);
    return actor.handle();
  }
}
