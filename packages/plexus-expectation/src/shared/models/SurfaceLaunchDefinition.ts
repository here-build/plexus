import { syncing } from "@here.build/plexus";

import { LaunchDefinition } from "./LaunchDefinition.js";

/**
 * Human-fulfilled work (approvals): the actor is inert, settlement arrives as
 * the kernel operation `settleSurface` (design.md §7). The core has no surface
 * timeout — escalation is host policy.
 */
@syncing("@here.build/plexus-expectation:SurfaceLaunchDefinition")
export class SurfaceLaunchDefinition extends LaunchDefinition {}
