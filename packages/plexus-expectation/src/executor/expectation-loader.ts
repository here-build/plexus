import type { ExpectationActor } from "./expectation-actor.js";
import type { ActorHandle, LaunchContext, LoaderCapability } from "./types.js";
import type { Expectation } from "../shared/models/Expectation.js";

/**
 * Hermetic spawn boundary for one LaunchDefinition class, bound to the
 * expectation contract it launches (`E`).
 *
 * `load()` holds all async work (idempotent). `spawn()` is synchronous —
 * it runs inside the activation critical section. Cross-process loaders
 * override spawn and return an adapter whose handle is kernel-side truth;
 * the runner must self-terminate when claim presence disappears.
 */

export abstract class ExpectationLoader<
  E extends Expectation<any, any, never> = Expectation,
  TCapabilityArgs = unknown,
> {
  abstract load(): Promise<void>;

  /**
   * Advisory inventory only — kernel publishes, never gates activation on it.
   */
  probeCapability?(): Promise<LoaderCapability<TCapabilityArgs>>;

  protected abstract createActor(ctx: LaunchContext<E>): ExpectationActor<E>;

  spawn(ctx: LaunchContext<E>): ActorHandle {
    const actor = this.createActor(ctx);
    actor.start(ctx);
    return actor.handle();
  }
}
