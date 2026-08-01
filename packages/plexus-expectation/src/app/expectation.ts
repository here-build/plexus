/**
 * Abstract durable work unit.
 *
 * Product subclasses declare a static kind (`static readonly kind = "myapp.tool_call"`);
 * access via the instance getter `E.kind`. Clone always zeros `bindEpoch` / `rebindCount`
 * (claim identity is not inherited); open or terminal.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import { PewTerminalWriteError } from "./errors.js";
import { isTerminal, lifecycleCan, type Lifecycle } from "./lifecycle.js";

type ExpectationCtor = typeof Expectation & { readonly kind: string };

@syncing("@here.build/plexus-expectation:Expectation")
export abstract class Expectation extends PlexusModel {
  /**
   * Kind discriminator. Concrete subclasses declare
   * `static readonly kind = "product.kind_name"`.
   * (TS 5.8 cannot combine `abstract` + `static` on fields; enforce via runtime.)
   */
  static readonly kind: string = "";

  get kind(): string {
    const k = (this.constructor as ExpectationCtor).kind;
    if (!k) {
      throw new Error(`${this.constructor.name} must declare static readonly kind`);
    }
    return k;
  }

  @syncing accessor state: Lifecycle = "declared";
  @syncing accessor bindEpoch: number = 0;
  @syncing accessor rebindCount: number = 0;
  @syncing.child.list accessor children: Expectation[] = [];

  /**
   * Named writer for durable lifecycle.
   * Refuses any transition that would leave a terminal state.
   * Same-state writes are no-ops (idempotent dual-write friendly).
   *
   * `@syncing.action`: owns the batch (one update / one undo unit).
   * Do not wrap calls in `plexus.transact` — that nests and degrades the envelope.
   */
  @syncing.action
  transitionState(next: Lifecycle): void {
    const from = this.state;
    if (from === next) return;
    if (isTerminal(from) || !lifecycleCan(from, next)) {
      throw new PewTerminalWriteError(this, from, next);
    }
    this.state = next;
  }

  /**
   * Durable `running` + epoch bump in one action batch, before startResolver.
   * @returns new bindEpoch, or `0` if already terminal (race).
   */
  @syncing.action
  beginRunning(): number {
    if (isTerminal(this.state)) return 0;
    this.bindEpoch += 1;
    this.transitionState("running");
    return this.bindEpoch;
  }

  /**
   * Durable half of await-rebind (abort is claim-owner process-local).
   * When `incrementRebind`, bumps rebindCount in the same batch as the state write.
   */
  @syncing.action
  enterAwaitingRebind(incrementRebind: boolean): void {
    if (isTerminal(this.state)) return;
    if (incrementRebind) {
      this.rebindCount += 1;
    }
    if (this.state !== "awaiting_rebind") {
      this.transitionState("awaiting_rebind");
    }
  }

  /**
   * Settle from `running` to a terminal in one action. Returns false if raced
   * (not running, or epoch mismatch when `expectedEpoch` is set).
   */
  @syncing.action
  trySettleFromRunning(terminal: "sealed" | "failed" | "cancelled", expectedEpoch?: number): boolean {
    if (this.state !== "running") return false;
    if (expectedEpoch !== undefined && this.bindEpoch !== expectedEpoch) return false;
    this.transitionState(terminal);
    return true;
  }

  /**
   * Durable cancel of this node and owned descendants (children first).
   * Abort of resolver handles is claim-owner host responsibility before this call.
   */
  @syncing.action
  cancelSubtreeDurable(): void {
    for (const child of this.children.toReversed()) {
      child.cancelSubtreeDurable();
    }
    if (!isTerminal(this.state)) {
      this.transitionState("cancelled");
    }
  }

  /**
   * Plexus clone: copy product fields + lifecycle; strip claim counters on the clone.
   * Source unchanged. Placement / activation after clone is product responsibility.
   */
  override clone<T extends PlexusModel>(this: T, newProps: Partial<Omit<T, keyof PlexusModel>> = {}): T {
    return super.clone({
      ...newProps,
      bindEpoch: 0,
      rebindCount: 0,
    } as Partial<Omit<T, keyof PlexusModel>>) as T;
  }
}
