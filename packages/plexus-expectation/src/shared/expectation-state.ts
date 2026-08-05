/**
 * Per-Expectation presence lens. Session hub from `E.__doc__`; claim/report
 * reads ride the ambient `awareness.reactive` lens and the hub's actor catalog.
 */

import { docPlexus, type PlexusAwareness } from "@here.build/plexus";
import { computed } from "mobx";

import type { IntentRecord } from "./control.js";
import type { Expectation } from "./models/Expectation.js";
import type { PEW } from "./presence.js";

export class ExpectationState {
  constructor(
    public readonly pew: PEW,
    public readonly expectation: Expectation,
  ) {}

  /** Session hub for this entity (null when doc/plexus not linked). */
  get sessionHub(): PlexusAwareness | null {
    const doc = this.expectation.__doc__;
    if (!doc) return null;
    const plexus = docPlexus.get(doc);
    if (!plexus) return null;
    return plexus.awareness;
  }

  /**
   * Live actor frame. Assigned processorClientId → that base's `report` field
   * atom; unassigned → membership via clientIds so pre-spawn autoruns re-fire.
   */
  @computed
  get report(): unknown | undefined {
    const hub = this.sessionHub;
    if (!hub) return undefined;
    const reactive = hub.reactive;
    const cid = this.expectation.processorClientId;
    if (!isLegalPewClientId(cid)) {
      void reactive.clientIds;
      return undefined;
    }
    const v = reactive.clients.get(cid).field("report");
    return v === null ? undefined : v;
  }

  /** Sole-claim membership for this E on its session hub. */
  @computed
  get isBound(): boolean {
    const hub = this.sessionHub;
    if (!hub) return false;
    const claims = this.pew.actorsForHub(hub).claims;
    if (claims.length !== 1) return false;
    return claims[0]!.binds.some((b) => b.uuid === this.expectation.uuid);
  }

  /** Author intents targeting this Expectation. */
  @computed
  get intents(): readonly IntentRecord[] {
    const hub = this.sessionHub;
    if (!hub) return [];
    const uuid = this.expectation.uuid;
    return this.pew.actorsForHub(hub).intents.filter((intent) => intent.target.uuid === uuid);
  }
}

function isLegalPewClientId(cid: number): boolean {
  return typeof cid === "number" && cid !== 0 && Number.isFinite(cid);
}
