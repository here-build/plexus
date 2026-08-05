import { PlexusModel, syncing } from "@here.build/plexus";

import type { Expectation } from "./Expectation.js";

/**
 * Durable triad config on the doc. Loader association is by class on the host;
 * `kind` is only the CRDT registry key. No progress policy here — report shape
 * is the actor's. `E` declares which expectation this definition launches —
 * the third leg of the typed triad (types only; nothing on the wire).
 */
@syncing("@here.build/plexus-expectation:LaunchDefinition")
export abstract class LaunchDefinition<E extends Expectation<any, any, never> = Expectation> extends PlexusModel {
  static readonly acceptsMessages: boolean = false;

  /** Phantom triad binding — never assigned, never serialized. */
  declare readonly __expects__?: E;

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

export type ExpectationOf<D extends LaunchDefinition<any>> = NonNullable<D["__expects__"]>;
