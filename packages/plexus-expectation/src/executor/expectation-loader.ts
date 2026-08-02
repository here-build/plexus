import type { ExpectationActor } from "./expectation-actor.js";
import type { ActorHandle, LaunchContext, LoaderCapability } from "./types.js";

/**
 * Hermetic spawning abstraction for one LaunchDefinition class. In-process,
 * child-process, isolate, remote — invisible above this boundary. The kernel
 * never injects itself here: the loader gets a context, the kernel gets a
 * handle, and the handle's surfaces are the only contact (design.md §9).
 *
 * `load()` is idempotent and holds ALL async work; `spawn()` is synchronous by
 * contract — it runs inside the kernel's activation critical section
 * (EXECUTION MODEL, design.md §7). Cross-process loaders override `spawn`
 * wholesale and return an adapter-backed handle; the adapter buffers frames
 * and settlement kernel-side and must self-terminate its runner when the
 * kernel's presence disappears.
 */
export abstract class ExpectationLoader<TInput = unknown, TCapabilityArgs = unknown> {
  abstract load(): Promise<void>;

  /**
   * Optional availability + argument-inventory probe (design.md §9). Sourced
   * here because the loader holds the connection; published by the kernel;
   * never interpreted by it.
   */
  probeCapability?(): Promise<LoaderCapability<TCapabilityArgs>>;

  protected abstract createActor(ctx: LaunchContext<TInput>): ExpectationActor<TInput, unknown, unknown>;

  spawn(ctx: LaunchContext<TInput>): ActorHandle {
    const actor = this.createActor(ctx);
    actor.start(ctx);
    return actor.handle();
  }
}
