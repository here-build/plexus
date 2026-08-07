/**
 * PEW presence — domain over the ambient `awareness.reactive` lens.
 *
 * Wire reactivity (membership, per-base fields, peer isolation) is the
 * substrate's: `awareness.reactive` (plexus-mobx-awareness/register), one lens
 * per hub, disposed with it. Serde is the substrate's too: models go into
 * `setField` and come back out of scans as live family instances
 * (plexus docs/awareness-coherence.md). PEW owns only its pens (claim /
 * author / catalog wire clients) and the domain scans over the lens.
 */

import "@here.build/plexus-mobx-awareness/register";

import { DefaultedWeakMap } from "@here.build/collections";
import { type AwarenessSerializable, type AwarenessShape, Plexus, PlexusAwareness } from "@here.build/plexus";

import type { CancellationRequestData, IntentRecord } from "./control.js";
import { ExpectationState } from "./expectation-state.js";
import type { AnyExpectation, Expectation, IntentOf } from "./models/Expectation.js";
import { PEWActorCatalog } from "./pew-actor-catalog.js";
import { PEWLoaderCatalog } from "./pew-loader-catalog.js";

export type LoaderCapability<TArgs = unknown> = {
  readonly status: "ready" | "blocked" | "unavailable";
  readonly door?: string;
  readonly args?: TArgs;
  readonly probedAt?: number;
};

export type LoaderHealth = "loading" | "loaded" | `failed:${string}`;

export type PlanAvailability = {
  readonly kind: string;
  readonly health: LoaderHealth | "unadvertised";
  readonly capability?: LoaderCapability;
  readonly source: "catalog" | "loader" | "both";
};

export type PewClaimRecord = {
  readonly clientId: number;
  readonly binds: readonly Expectation[];
};

export type ClaimPresenceStatus = {
  readonly binds: readonly Expectation[];
};

export type CatalogPresenceStatus = {
  readonly loaders: Readonly<Record<string, LoaderHealth>>;
  readonly capabilities: Readonly<Record<string, LoaderCapability>>;
};

export type PresencePort = {
  mintClient(): ActorPresenceClient;
};

export type ActorPresenceClient = {
  readonly clientID: number;
  setReport(frame: unknown): void;
  destroy(): void;
};

export type PewHubShape = AwarenessShape & {
  /**
   * Pen discriminator on the session hub.
   * - `kernel` — claim owner (binds)
   * - `catalog` — loaders + capabilities (orchestrator publish after probe)
   * - `loader` — per-loader self-record escape hatch
   * Actor progress pens carry `report` without a role marker.
   */
  role?: "kernel" | "catalog" | "loader";
  binds?: readonly Expectation[];
  loaders?: Readonly<Record<string, LoaderHealth>>;
  capabilities?: Readonly<Record<string, LoaderCapability>>;
  report?: AwarenessSerializable;
  intents?: readonly IntentRecord[];
  kind?: string;
  capability?: LoaderCapability;
};

export type PewOpts<P extends Plexus<any, PewHubShape> = Plexus<any, PewHubShape>> = {
  readonly kernel?: P | null;
};

export class PEW<P extends Plexus<any, PewHubShape> = Plexus<any, PewHubShape>> {
  readonly kernel: P | null;

  /** Kernel-hub plan inventory (loaders + capabilities merge). */
  readonly loaders = new PEWLoaderCatalog(this);

  readonly #actorCatalogs = new DefaultedWeakMap((awareness: PlexusAwareness) => new PEWActorCatalog(this, awareness));

  readonly expectationStates = new DefaultedWeakMap(
    (expectation: Expectation) => new ExpectationState(this, expectation),
  );

  constructor(opts?: PewOpts<P>) {
    this.kernel = opts?.kernel ?? null;
  }

  /** Per-expectation presence lens (report / isBound / intents-for-me). */
  of(E: Expectation): ExpectationState {
    return this.expectationStates.get(E);
  }

  /**
   * Ask the claim owner to steer this work. Entity-routed: the target carries
   * its hub, so there is no session to name and no cross-session mistake to
   * make. Typed by the target's contract — an expectation that declares no
   * intents (`TIntent = never`) cannot be requested at compile time. Returns
   * the intentId. No acks: the kernel mirrors the standing intent into the
   * bound actor's inbox; what the actor does with it is its own decision.
   */
  request<E extends AnyExpectation>(target: E, intent: IntentOf<E>): string {
    return this.#submit(target, intent, undefined);
  }

  /**
   * Ask the claim owner to cancel this work. An envelope verb — universal
   * (not TIntent-gated), handled by the kernel at admission, never the
   * actor's mailbox. `additionalData` rides as the body (`strength`
   * defaults to immediate; `reason` lands in `endDetail`).
   */
  requestCancellation(target: AnyExpectation, additionalData?: CancellationRequestData): string {
    return this.#submit(target, additionalData ?? {}, "cancel");
  }

  #submit(target: AnyExpectation, body: unknown, kind: "cancel" | undefined): string {
    const hub = this.of(target as Expectation).sessionHub;
    if (!hub) {
      throw new Error("PEW.request: target has no session hub — home the entity in a synced doc first");
    }
    return this.actorsForHub(hub).submitRequest(target as Expectation, body, kind);
  }

  /** Session-hub claim + intent lens. */
  actors(session: P): PEWActorCatalog {
    return this.#actorCatalogs.get(session.awareness as PlexusAwareness);
  }

  /** Same lens keyed by hub — for reads that start from `E.__doc__`. */
  actorsForHub(awareness: PlexusAwareness): PEWActorCatalog {
    return this.#actorCatalogs.get(awareness);
  }

  get awareness(): PlexusAwareness<PewHubShape> | null {
    return (this.kernel?.awareness as PlexusAwareness<PewHubShape> | undefined) ?? null;
  }
}

/** Pen minting — PEW never occupies clientId 0 (plexus-internal reservation). */
export function mintLocalNonZero(hub: PlexusAwareness): PlexusAwareness {
  for (let i = 0; i < 8; i++) {
    const client = PlexusAwareness.createLocalClient(hub);
    if (client.clientID !== 0) return client;
    client.destroy();
  }
  throw new Error("PEW: failed to mint non-zero awareness clientId");
}
