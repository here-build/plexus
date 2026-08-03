import { syncing } from "@here.build/plexus";

import { LaunchDefinition } from "./LaunchDefinition.js";

/** Human-fulfilled work: inert actor; settlement is settleSurface. No core timeout. */
@syncing("@here.build/plexus-expectation:SurfaceLaunchDefinition")
export class SurfaceLaunchDefinition extends LaunchDefinition {}
