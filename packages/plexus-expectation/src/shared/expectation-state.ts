/**
 * Per-Expectation presence lens. Session hub from `E.__doc__`; report / intents
 * ride the ambient `awareness.reactive` lens.
 *
 * Intents / cancels are the target's own lanes across author pens:
 *   `expectation:${uuid}:intents` / `expectation:${uuid}:cancellation`
 * `isBound` is process-local lifecycle (running): singleton claim is the
 * singular pew-daemon.
 */

import { docPlexus, type PlexusAwareness } from "@here.build/plexus";
import { computed } from "mobx";

import type { CancellationLaneEntry, IntentLaneEntry } from "./control.js";
import type { Expectation } from "./models/Expectation.js";
import { collectCancellationLane, collectIntentLane } from "./pew-actor-catalog.js";
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

  /**
   * Whether this unit is currently claimed for execution.
   * Single pew-daemon: equivalent to lifecycle running (local table is sole truth).
   */
  @computed
  get isBound(): boolean {
    return this.expectation.state === "running";
  }

  /** Standing steers on this expectation's intents lane (all peers). */
  @computed
  get intents(): readonly IntentLaneEntry[] {
    const hub = this.sessionHub;
    if (!hub) return [];
    return collectIntentLane(hub, this.expectation.uuid);
  }

  /** Standing cancels on this expectation's cancellation lane (all peers). */
  @computed
  get cancellations(): readonly CancellationLaneEntry[] {
    const hub = this.sessionHub;
    if (!hub) return [];
    return collectCancellationLane(hub, this.expectation.uuid);
  }
}

function isLegalPewClientId(cid: number): boolean {
  return typeof cid === "number" && cid !== 0 && Number.isFinite(cid);
}
