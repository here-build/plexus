/**
 * Durable launch plans — hermetic config + class capability contract.
 *
 * Claim-owner invocation lives on {@link LaunchRuntime} (runtime package), not
 * on this CRDT entity (Fable H3: plane split). No durable importPath (H4).
 *
 * Capabilities are **static class attributes**, not @syncing fields.
 * Instance @syncing fields are worker configuration only.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import type { ProgressMode } from "../app/progress-plane.js";

type LaunchDefinitionCtor = typeof LaunchDefinition & {
  readonly acceptsMessages: boolean;
  readonly emitsProgress: boolean;
  readonly progressMode: ProgressMode;
};

/**
 * Abstract durable plan under `Orchestration.actors`.
 * Subclass for real plans; do not bag free-form launch flags on the base.
 */
@syncing("@here.build/plexus-expectation:LaunchDefinition")
export abstract class LaunchDefinition extends PlexusModel {
  /** Class contract: may receive ExpectationAdjustments / messages. */
  static readonly acceptsMessages: boolean = false;
  /** Class contract: body may emit progress. */
  static readonly emitsProgress: boolean = false;
  /** Class contract: progress coalesce when emitsProgress. */
  static readonly progressMode: ProgressMode = "none";

  get acceptsMessages(): boolean {
    return (this.constructor as LaunchDefinitionCtor).acceptsMessages;
  }

  get emitsProgress(): boolean {
    return (this.constructor as LaunchDefinitionCtor).emitsProgress;
  }

  get progressMode(): ProgressMode {
    return (this.constructor as LaunchDefinitionCtor).progressMode;
  }

  /**
   * Plain data for runners / tests (not a Plexus model).
   * Includes class triad + subclass config.
   */
  toSnapshot(): LaunchDefinitionSnapshot {
    return {
      acceptsMessages: this.acceptsMessages,
      emitsProgress: this.emitsProgress,
      progressMode: this.progressMode,
      config: this.snapshotConfig(),
    };
  }

  /** Strategy-specific durable fields as plain data. */
  protected snapshotConfig(): Readonly<Record<string, unknown>> {
    return {};
  }
}

/**
 * In-process claim-owner body (host ports inject session/tool modules).
 * Default: no progress surface — use {@link ProgressiveInProcessLaunchDefinition}
 * when the kind streams.
 */
@syncing("@here.build/plexus-expectation:InProcessLaunchDefinition")
export class InProcessLaunchDefinition extends LaunchDefinition {
  static override readonly acceptsMessages: boolean = false;
  static override readonly emitsProgress: boolean = false;
  static override readonly progressMode: ProgressMode = "none";

  /**
   * Optional body/eval payload for hermetic in-process plans.
   * Not capability flags.
   */
  @syncing accessor source: string = "";

  protected override snapshotConfig(): Readonly<Record<string, unknown>> {
    return this.source ? { source: this.source } : {};
  }
}

/**
 * In-process plan that emits LWW progress (e.g. completion streaming).
 */
@syncing("@here.build/plexus-expectation:ProgressiveInProcessLaunchDefinition")
export class ProgressiveInProcessLaunchDefinition extends InProcessLaunchDefinition {
  static override readonly emitsProgress: boolean = true;
  static override readonly progressMode: ProgressMode = "lww";
}

/**
 * Human / surface fulfillers (settleSurface path).
 */
@syncing("@here.build/plexus-expectation:SurfaceLaunchDefinition")
export class SurfaceLaunchDefinition extends LaunchDefinition {
  static override readonly acceptsMessages: boolean = false;
  static override readonly emitsProgress: boolean = false;
  static override readonly progressMode: ProgressMode = "none";
}

/** Independent copy of plan scalars for runners (law 5). */
export type LaunchDefinitionSnapshot = {
  readonly acceptsMessages: boolean;
  readonly emitsProgress: boolean;
  readonly progressMode: ProgressMode;
  readonly config: Readonly<Record<string, unknown>>;
};
