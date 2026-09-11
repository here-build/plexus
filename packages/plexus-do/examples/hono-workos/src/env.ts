import type { PlexusSyncEnv } from "@here.build/plexus-do";

export interface Env extends PlexusSyncEnv {
  DOC_LEADER: DurableObjectNamespace<import("./doc-leader.js").DocLeader>;
  WORKOS_CLIENT_ID: string;
  WORKOS_ISSUER?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}
