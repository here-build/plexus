import { PlexusModel, syncing } from "@here.build/plexus";

import type { ProgressMode } from "../app/progress-plane.js";

/** Built-in modes; hosts may register additional string modes. */
export type LaunchMode = "inprocess" | "surface" | (string & {});

export type { ProgressMode };

/**
 * Durable plan entry: how a kind is launched and what capabilities it exposes.
 * Registry values under `Orchestration.actors`.
 */
@syncing("@here.build/plexus-expectation:LaunchDefinition")
export class LaunchDefinition extends PlexusModel {
  /** Resolver host mode the claim owner must have loaded. */
  @syncing accessor launchMode: LaunchMode = "inprocess";

  /** Reserved: product intents may message the live resolver. */
  @syncing accessor acceptsMessages: boolean = false;

  @syncing accessor emitsProgress: boolean = false;

  /** Progress coalesce policy when `emitsProgress` is true. */
  @syncing accessor progressMode: ProgressMode = "none";
}
