import { syncing } from "@here.build/plexus";

import { LaunchDefinition } from "./LaunchDefinition.js";

@syncing("@here.build/plexus-expectation:InProcessLaunchDefinition")
export class InProcessLaunchDefinition extends LaunchDefinition {
  @syncing accessor source: string = "";

  protected override snapshotConfig(): Readonly<Record<string, unknown>> {
    return this.source ? { source: this.source } : {};
  }
}
