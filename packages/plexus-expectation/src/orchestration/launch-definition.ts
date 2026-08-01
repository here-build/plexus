/**
 * Launch strategies — how a kind of Expectation is run.
 *
 * LaunchDefinition is an **abstract self-contained plan**: durable config for
 * the target worker, without the live invocation function (that stays on the
 * claim-owner host as StartResolverFn). Subclasses declare strategy + fields.
 *
 * Drop `launchMode` string generalization — each strategy is its own type.
 * Product packages may add further subclasses (e.g. LocalAcpLaunchDefinition).
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import type { ProgressMode } from "../app/progress-plane.js";

/**
 * Abstract plan entry under `Orchestration.actors`.
 * Shared capability flags; strategy identity is the concrete class.
 */
@syncing("@here.build/plexus-expectation:LaunchDefinition")
export abstract class LaunchDefinition extends PlexusModel {
  /**
   * Host strategy key — what capability the claim owner must provide.
   * Concrete subclasses return a stable string (`"inprocess"`, `"surface"`, …).
   * Not stored as a free-form mode enum on the base class.
   */
  abstract get strategy(): string;

  /** Reserved: product may deliver ExpectationAdjustments / messages into the live resolver. */
  @syncing accessor acceptsMessages: boolean = false;

  @syncing accessor emitsProgress: boolean = false;

  /** Progress coalesce policy when `emitsProgress` is true. */
  @syncing accessor progressMode: ProgressMode = "none";

  /**
   * Plain snapshot for resolvers (law 5 — no mutable plan entity in the body).
   * Subclasses may override to attach strategy-specific config.
   */
  toSnapshot(): LaunchDefinitionSnapshot {
    return {
      strategy: this.strategy,
      acceptsMessages: this.acceptsMessages,
      emitsProgress: this.emitsProgress,
      progressMode: this.progressMode,
      config: this.snapshotConfig(),
    };
  }

  /** Strategy-specific durable fields as plain data (default none). */
  protected snapshotConfig(): Readonly<Record<string, unknown>> {
    return {};
  }
}

/**
 * Claim-owner in-process body (StartResolverFn in this process).
 * No extra durable config — the host maps kind → module.
 */
@syncing("@here.build/plexus-expectation:InProcessLaunchDefinition")
export class InProcessLaunchDefinition extends LaunchDefinition {
  override get strategy(): string {
    return "inprocess";
  }
}

/**
 * Human / surface fulfillers (no paid OS process).
 * Host must support surface settle path.
 */
@syncing("@here.build/plexus-expectation:SurfaceLaunchDefinition")
export class SurfaceLaunchDefinition extends LaunchDefinition {
  override get strategy(): string {
    return "surface";
  }
}

/** Independent copy of plan scalars for resolver start (not a Plexus model). */
export type LaunchDefinitionSnapshot = {
  readonly strategy: string;
  readonly acceptsMessages: boolean;
  readonly emitsProgress: boolean;
  readonly progressMode: ProgressMode;
  /** Strategy-specific fields (e.g. baseUrl for local ACP). */
  readonly config: Readonly<Record<string, unknown>>;
};

/**
 * @deprecated Use {@link LaunchDefinition.strategy} / concrete subclasses.
 * Kept as alias for transitional host checks (`supportsLaunchMode` → strategy).
 */
export type LaunchMode = string;
