import { PlexusModel, syncing } from "@here.build/plexus";

import { LaunchDefinition } from "./launch-definition.js";

/**
 * Session-scoped plan registry: kind → {@link LaunchDefinition}.
 * Product roots place this as a child (e.g. session root's `orchestration` field).
 */
@syncing("@here.build/plexus-expectation:Orchestration")
export class Orchestration extends PlexusModel {
  /** Kind string → launch plan. Unknown kind → plan resolution `missing`. */
  @syncing.child.map accessor actors: Map<string, LaunchDefinition> = new Map();
}
