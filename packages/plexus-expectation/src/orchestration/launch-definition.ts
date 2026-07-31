import { PlexusModel, syncing } from "@here.build/plexus";

/** First-slice modes; host may register additional string modes later. */
export type LaunchMode = "inprocess" | "surface" | (string & {});

/** How progress patches coalesce on the claim owner. */
export type ProgressMode = "lww" | "append" | "none";

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

  /** Whether the resolver is expected to emit progress patches. */
  @syncing accessor emitsProgress: boolean = false;

  /** Progress coalesce policy when {@link emitsProgress} is true. */
  @syncing accessor progressMode: ProgressMode = "none";
}
