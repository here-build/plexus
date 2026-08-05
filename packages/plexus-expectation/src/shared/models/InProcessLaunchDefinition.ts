import { syncing } from "@here.build/plexus";

import type { AnyExpectation, Expectation } from "./Expectation.js";
import { LaunchDefinition } from "./LaunchDefinition.js";

@syncing("@here.build/plexus-expectation:InProcessLaunchDefinition")
export class InProcessLaunchDefinition<E extends AnyExpectation = Expectation> extends LaunchDefinition<E> {
  @syncing accessor source: string = "";

  protected override snapshotConfig(): Readonly<Record<string, unknown>> {
    return this.source ? { source: this.source } : {};
  }
}
