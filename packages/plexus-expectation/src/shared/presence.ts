/**
 * PEW presence — domain over the ambient `awareness.reactive` lens.
 *
 * Wire reactivity (membership, per-base fields, peer isolation) is the
 * substrate's: `awareness.reactive` (plexus-mobx-awareness/register), one lens
 * per hub, disposed with it. Serde is the substrate's too: models go into
 * `setField` and come back out of scans as live family instances
 * (plexus docs/awareness-coherence.md).
 *
 * PEW pens on the session hub:
 *   - **actor** — per-unit `report` (minted by the claim-owner orchestrator)
 *   - **author** — per-expectation lanes
 *       `expectation:${uuid}:intents` and `expectation:${uuid}:cancellation`
 *   - **catalog** — loaders + capabilities
 *
 * No flat intents bag and no claim-binds pen. Singleton claim is product
 * topology (singular pew-daemon). Lanes are hermetic: authors write the
 * target's field; actors / cancel admission read it.
 */

import "@here.build/plexus-mobx-awareness/register";

import { DefaultedWeakMap } from "@here.build/collections";
import { type AwarenessSerializable, type AwarenessShape, Plexus, PlexusAwareness } from "@here.build/plexus";

import type { CancellationRequestData } from "./control.js";
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

/** Process-local held work snapshot (orchestrator table) — not an awareness bag. */
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
   * - `catalog` — loaders + capabilities (orchestrator publish after probe)
   * - `loader` — per-loader self-record escape hatch
   * Actor progress pens carry `report` without a role marker.
   * Author pens carry `expectation:${uuid}:intents` and
   * `expectation:${uuid}:cancellation` (open string keys on
   * {@link AwarenessShape}) without a role marker.
   */
  role?: "catalog" | "loader";
  loaders?: Readonly<Record<string, LoaderHealth>>;
  capabilities?: Readonly<Record<string, LoaderCapability>>;
  report?: AwarenessSerializable;
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
   * Publish a steer on the target's intents lane
   * (`expectation:${uuid}:intents`). Entity-routed: the target carries its
   * hub. Typed by the target's contract — `TIntent = never` cannot be requested.
   * No acks: the bound actor reads the lane hermetically.
   */
  request<E extends AnyExpectation>(target: E, intent: IntentOf<E>): string {
    const hub = this.of(target as Expectation).sessionHub;
    if (!hub) {
      throw new Error("PEW.request: target has no session hub — home the entity in a synced doc first");
    }
    return this.actorsForHub(hub).appendIntent(target as Expectation, intent);
  }

  /**
   * Publish a cancel on the target's cancellation lane
   * (`expectation:${uuid}:cancellation`). Envelope verb — universal (not
   * TIntent-gated); claim-owner admits from that lane (not the actor mailbox).
   * `additionalData` rides as the body.
   */
  requestCancellation(target: AnyExpectation, additionalData?: CancellationRequestData): string {
    const hub = this.of(target as Expectation).sessionHub;
    if (!hub) {
      throw new Error("PEW.requestCancellation: target has no session hub — home the entity in a synced doc first");
    }
    return this.actorsForHub(hub).appendCancellation(target as Expectation, additionalData ?? {});
  }

  /** Session-hub actor + intent lens. */
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
