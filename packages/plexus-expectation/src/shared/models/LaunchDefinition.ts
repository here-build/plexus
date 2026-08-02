import { PlexusModel, syncing } from "@here.build/plexus";

/**
 * Durable plan for a triad — config that travels with the doc. Association to
 * a loader is by CLASS on the claim-owner host (design.md §9); the registry
 * string kind exists only as the CRDT map key.
 *
 * No progress policy lives here: report shape is the actor's own (design.md
 * §16, progress modes in the core).
 */
@syncing("@here.build/plexus-expectation:LaunchDefinition")
export abstract class LaunchDefinition extends PlexusModel {
  /** Whether executions of this plan observe steering intents (design.md §8 admission). */
  static readonly acceptsMessages: boolean = false;

  get ctor(): typeof LaunchDefinition {
    return this.constructor as typeof LaunchDefinition;
  }

  get acceptsMessages(): boolean {
    return this.ctor.acceptsMessages;
  }

  toSnapshot(): LaunchDefinitionSnapshot {
    return {
      acceptsMessages: this.acceptsMessages,
      config: this.snapshotConfig(),
    };
  }

  protected snapshotConfig(): Readonly<Record<string, unknown>> {
    return {};
  }
}

export type LaunchDefinitionSnapshot = {
  readonly acceptsMessages: boolean;
  readonly config: Readonly<Record<string, unknown>>;
};
