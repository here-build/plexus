import {
  ExpectationLoader,
  type ActorHandle,
  type ActorPresenceClient,
  type ExpectationActor,
  type LaunchContext,
  type PresencePort,
} from "@here.build/plexus-expectation/executor";
import invariant from "tiny-invariant";

import type { DeclarePort, PresenceHubPort } from "./ports.js";

/**
 * `InProcessLoader` — the host-surface base for in-process triads that want
 * the declare port (proposal §7 G15/G16) and/or real presence-hub wiring
 * (proposal §8 G10). Neither capability can be added from `kernel.ts` alone:
 *
 * WHY THE LOADER, NOT THE KERNEL, IS THE SEAM. The `ctx: LaunchContext` an
 * actor receives is built entirely INSIDE `Orchestrator.activate`'s
 * synchronous critical section (a separate, unmodifiable package) and handed
 * straight to `loader.spawn(ctx)` — by the time `DoOrchestrator.activate`
 * (kernel.ts) regains control, `loader.spawn` has already returned a handle;
 * there is no hook to inject fields into the `ctx` object the actor saw.
 * `getPresenceHub()` (which `Orchestrator` DOES call before building `ctx`) is
 * hard-wired internally to `PlexusAwareness.createLocalClient` and cannot be
 * swapped for `PresenceHubPort` (structurally the same wrapped-client shape,
 * but not a `PlexusAwareness` instance) without editing `Orchestrator` itself
 * — out of scope (non-goal: touching the PEW core). The one place still under
 * this package's control is the LOADER: like `DurableObjectLoader`, this class
 * overrides `spawn(ctx)` WHOLESALE and hands the actor a richer context object
 * it builds itself, before `createDoActor`/`actor.start` ever see it.
 *
 * FILLED CONTRACT GAP — `ctx.input` MUST CARRY THE UUID, again. Same shape as
 * `actor-do-loader.ts`'s gap: `LaunchContext` has no uuid field of its own, and
 * the declare port must know WHICH Expectation is requesting a child (to home
 * it under the right parent — the parent must already be reachable from the
 * open-work roots for the work-roots law to hold for free). The one channel
 * that reaches `spawn(ctx)` is `ctx.input`, so any Expectation subclass loaded
 * through an `InProcessLoader` MUST override `snapshotInput()` to include its
 * own uuid (see `src/__tests__/_helpers/do-test-host.ts`'s `DeclaringDoExpectation`
 * for the pattern).
 *
 * NO DURABLE PEN GUARANTEE. `declare` and `presence` below are built as bare
 * closures over `binding` (kernel-held) and `parentUuid` (a string, not a live
 * entity ref) — the actor's whole reachable surface through `ctx.declare` is
 * `{ declare(kind, fields): string }`. It cannot reach `storage`, the session
 * doc, or the parent `Expectation` instance; the mint transaction itself runs
 * inside `DoOrchestrator`'s `#mintDeclaredChild` (kernel.ts), which holds the
 * only reference to the doc and the storage port.
 */

/** Bound once at mount, before any spawn (`kernel.ts#mount`) — never call this from host/product code. */
export type MintChildFn = (parentUuid: string, kind: string, fields: Record<string, unknown>) => string;

/** What `installKernel` hands every registered `InProcessLoader`, exactly once, at mount. */
export type DoHostBinding = {
  readonly mintChild: MintChildFn;
  readonly presenceHub: PresenceHubPort;
};

/** `LaunchContext` plus this package's host-surface addition — never a core PEW type (see class preamble). */
export type DoLaunchContext<TInput = unknown> = LaunchContext<TInput> & {
  readonly declare: DeclarePort;
};

export abstract class InProcessLoader<TInput = unknown> extends ExpectationLoader<TInput> {
  #binding: DoHostBinding | null = null;

  /** `installKernel`-internal wiring — not for host code to call directly. */
  __bindDoHost(binding: DoHostBinding): void {
    this.#binding = binding;
  }

  // Unreachable: `spawn` is overridden wholesale below (mirrors
  // `DurableObjectLoader`'s documented pattern) — the base `ExpectationLoader.spawn`
  // (the only caller of `createActor`) is never invoked on this class.
  protected createActor(): ExpectationActor<TInput, unknown, unknown> {
    throw new Error("InProcessLoader.createActor is unreachable — spawn() is overridden wholesale (see createDoActor)");
  }

  /** Subclasses implement this instead of `createActor` — receives the declare/presence-augmented context. */
  protected abstract createDoActor(ctx: DoLaunchContext<TInput>): ExpectationActor<TInput, unknown, unknown>;

  override spawn(ctx: LaunchContext<TInput>): ActorHandle {
    const binding = this.#binding;
    invariant(
      binding,
      "InProcessLoader used before installKernel bound it — register this loader in " +
        "InstallOpts#loaders before calling installKernel()",
    );
    const input = ctx.input as { readonly uuid?: unknown };
    invariant(
      typeof input.uuid === "string" && input.uuid.length > 0,
      "InProcessLoader: ctx.input must carry a string `uuid` field — a declaring triad's " +
        "snapshotInput() must include it (see in-process-loader.ts preamble)",
    );
    const parentUuid = input.uuid;

    // Declare port (G15/G16): fire-and-forget request, closed over the
    // parent's uuid only — the actor never sees the parent entity, the doc,
    // or storage. The mint transaction lives in DoOrchestrator#mintDeclaredChild.
    const declare: DeclarePort = {
      declare: (kind, fields) => binding.mintChild(parentUuid, kind, fields),
    };

    // Presence-hub wiring (§8 G10): mint on the SESSION HUB via the real
    // PresenceHubPort, not core's inert `getPresenceHub()` fallback (which
    // this loader never touches — `richCtx.presence` below replaces the
    // context field the actor actually reads). At most one client per spawn,
    // mirroring core's own `#mintPresencePort` discipline. `destroy()` at
    // fold: `ctx.signal` is the same AbortController core's `fold()` aborts
    // for EVERY node in the folded subtree (settlement or not), so this is
    // the one signal available to release the client when the execution ends.
    let mintedClient: ActorPresenceClient | null = null;
    const presence: PresencePort = {
      mintClient: () => {
        mintedClient?.destroy();
        const client = binding.presenceHub.mintClient();
        mintedClient = client;
        return client;
      },
    };
    ctx.signal.addEventListener("abort", () => mintedClient?.destroy(), { once: true });

    const richCtx: DoLaunchContext<TInput> = { ...ctx, declare, presence };
    const actor = this.createDoActor(richCtx);
    actor.start(richCtx);
    return actor.handle();
  }
}
