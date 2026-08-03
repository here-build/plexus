import { PlexusModel, syncing } from "@here.build/plexus";

/**
 * Durable triad config on the doc. Loader association is by class on the host;
 * `kind` is only the CRDT registry key. No progress policy here — report shape
 * is the actor's.
 */
@syncing("@here.build/plexus-expectation:LaunchDefinition")
export abstract class LaunchDefinition extends PlexusModel {
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
