/**
 * Durable simplex treatment beacon (ExpectationAdjustment).
 *
 * Not an Expectation subclass; not nested in E.children.
 * `intentId` correlates with ExpectationAdjustmentIntent / presence (C3).
 * `uuid` is Plexus auto — never assign from intentId.
 * Consumption acks do not write the target Expectation (C2).
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import {
  type AdjustmentConsumptionState,
  type ExpectationAdjustmentIntent,
} from "./control.js";
import { PewTerminalWriteError } from "./errors.js";
import {
  adjustmentCan,
  canReshapeAdjustment,
  isAdjustmentTerminal,
} from "./adjustment-lifecycle.js";

@syncing("@here.build/plexus-expectation:ExpectationAdjustment")
export class ExpectationAdjustment extends PlexusModel {
  /**
   * Author-stable correlation with Intent/presence.
   * Not equal to {@link PlexusModel.uuid} (C3).
   */
  @syncing accessor intentId: string = "";

  /** Target Expectation wire identity. */
  @syncing accessor targetUuid: string = "";

  @syncing accessor reshapeEpoch: number = 0;

  /**
   * Opaque payload for actor-domain — PEW never interprets.
   * Stored as JSON string so the field stays a Yjs-legal scalar (C3 body opacity).
   */
  @syncing accessor bodyJson: string = "null";

  get body(): unknown {
    try {
      return JSON.parse(this.bodyJson) as unknown;
    } catch {
      return this.bodyJson;
    }
  }

  set body(value: unknown) {
    this.bodyJson = JSON.stringify(value === undefined ? null : value);
  }

  @syncing accessor consumption: AdjustmentConsumptionState = "queued";

  /**
   * Named writer for consumption lifecycle.
   * Same-state no-op; illegal edges throw (mirror Expectation discipline).
   */
  @syncing.action
  transitionConsumption(next: AdjustmentConsumptionState): void {
    const from = this.consumption;
    if (from === next) return;
    if (isAdjustmentTerminal(from) || !adjustmentCan(from, next)) {
      throw new PewTerminalWriteError(this, from, next);
    }
    this.consumption = next;
  }

  /** In-place body upgrade (escalate reshapeEpoch). */
  @syncing.action
  applyReshape(body: unknown, nextEpoch: number): boolean {
    if (!canReshapeAdjustment(this.consumption, this.reshapeEpoch, nextEpoch)) {
      return false;
    }
    this.bodyJson = JSON.stringify(body === undefined ? null : body);
    this.reshapeEpoch = nextEpoch;
    return true;
  }

  /**
   * Begin retract: announced|queued → withdrawn (no actor yet);
   * delivered|accepted → withdrawing (needs ackDropped).
   * All edges go through {@link transitionConsumption} (machine-honest).
   */
  @syncing.action
  markWithdrawing(): boolean {
    const from = this.consumption;
    if (from === "withdrawing" || from === "withdrawn") return true;
    if (isAdjustmentTerminal(from)) return false;
    if (from === "announced" || from === "queued") {
      this.transitionConsumption("withdrawn");
      return true;
    }
    if (from === "delivered" || from === "accepted") {
      this.transitionConsumption("withdrawing");
      return true;
    }
    return false;
  }

  /** Completes retract after actor ackDropped — only legal from withdrawing. */
  @syncing.action
  markWithdrawn(): boolean {
    if (this.consumption === "withdrawn") return true;
    if (this.consumption !== "withdrawing") return false;
    this.transitionConsumption("withdrawn");
    return true;
  }

  /** Target E terminal / policy refuse — machine edge to refused. */
  @syncing.action
  markRefused(): boolean {
    if (this.consumption === "refused") return true;
    if (isAdjustmentTerminal(this.consumption)) return false;
    if (!adjustmentCan(this.consumption, "refused")) return false;
    this.transitionConsumption("refused");
    return true;
  }

  /** Fill fields from intent at materialize (caller sets after construct). */
  static fillFromIntent(adj: ExpectationAdjustment, intent: ExpectationAdjustmentIntent): void {
    adj.intentId = intent.intentId;
    adj.targetUuid = intent.targetUuid;
    adj.reshapeEpoch = intent.reshapeEpoch;
    adj.bodyJson = JSON.stringify(intent.body === undefined ? null : intent.body);
    adj.consumption = "queued";
  }
}

/**
 * Product root implements this (or exposes a list PEW can walk).
 * PEW never hardcodes SessionRoot.
 */
export type AdjustmentBag = {
  readonly adjustments: readonly ExpectationAdjustment[];
  addAdjustment(adj: ExpectationAdjustment): void;
  removeAdjustment?(adj: ExpectationAdjustment): void;
};
