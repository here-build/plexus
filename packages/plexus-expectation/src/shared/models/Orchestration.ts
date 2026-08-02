import { PlexusModel, syncing } from "@here.build/plexus";

import { LaunchDefinition } from "./LaunchDefinition.js";

@syncing("@here.build/plexus-expectation:Orchestration")
export class Orchestration extends PlexusModel {
  @syncing.child.map accessor plans: Map<string, LaunchDefinition> = new Map();
}
