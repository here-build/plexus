import { type PlexusAwareness, PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { type EndCause } from "../control.js";
import { PewTerminalWriteError } from "../errors.js";
import { lifecycleCan, lifecycleEventAfter, type LifecycleEventName, type Lifecycle } from "../lifecycle-machine.js";
import { isTerminal, type TerminalLifecycle } from "../lifecycle.js";

type ExpectationCtor = typeof Expectation & { readonly kind: string };

/**
 * Durable face of one unit of open work. Promise / generator / FSM /
 * continuation — one entity, four views (design.md §4).
 *
 * ONE RECORD, ONE WRITER (design.md §2). The authorship phase — minting the
 * entity, its declaration fields, and `declared`, in ONE transaction — belongs
 * to the host; the kernel's first durable write ends it, and from then on
 * every durable write on this entity is the kernel's. The lifecycle actions
 * below are the kernel's pens (plus `authorCancel`, the one author-held
 * terminal); actors never hold any of them. Enforcement is the executor import
 * split plus the FSM guards — Plexus itself accepts any write.
 *
 * Progress does NOT live here. The actor owns its awareness record; this class
 * carries only the discovery pointer (`processorClientId`) and the terminal
 * fold of the final frame (`lastReportJson`). Hub state on the model class is
 * a rejected shape (design.md §16, kernel-relayed progress).
 */
@syncing("@here.build/plexus-expectation:Expectation")
export abstract class Expectation<TResult = unknown, TReport = unknown> extends PlexusModel {
  static readonly kind: string = "";

  get kind(): string {
    const k = (this.constructor as ExpectationCtor).kind;
    invariant(k, `${this.constructor.name} must declare static readonly kind`);
    return k;
  }

  @syncing
  accessor state: Lifecycle = "declared";

  /** Empty while open; set once, in the terminal transaction. */
  @syncing
  accessor endCause: EndCause | "" = "";

  /**
   * Diagnostic for the terminal: fail reason, cancel reason, crash error,
   * `applySettlement` error. `sealed` + non-empty endDetail is the
   * partial-apply marker — degraded success, never silently full success.
   */
  @syncing
  accessor endDetail: string = "";

  /** Final buffered frame, folded at terminal. `"null"` = never reported. */
  @syncing
  accessor lastReportJson: string = "null";

  /**
   * Discovery pointer to the actor's awareness client on the session hub.
   * 0 = no presence (inert surface actors) — observers must treat 0 as none,
   * never resolve it.
   */
  @syncing
  accessor processorClientId: number = 0;

  @syncing.child.list
  accessor children: Expectation[] = [];

  /** TInput snapshot at spawn — the execution's authoritative view of the declaration. */
  snapshotInput(): unknown {
    return {};
  }

  /**
   * Seal-path product-field writes; runs inside the kernel's terminal
   * transaction — entity-typed logic, kernel-held pen. Throwing does not roll
   * back the terminal (design.md §7).
   */
  applySettlement(_result: TResult): void {}

  get lastReport(): TReport | null {
    try {
      return JSON.parse(this.lastReportJson) as TReport | null;
    } catch {
      return null;
    }
  }

  /**
   * Observer read of the live actor frame via the discovery pointer.
   * `undefined` = no live record (not attached, or peer gone); prefer
   * `lastReport` once terminal.
   */
  liveReport(hub: PlexusAwareness): TReport | null | undefined {
    const cid = this.processorClientId;
    if (cid === 0) return undefined;
    const peer = hub.getPeer(cid);
    if (!peer) return undefined;
    return (peer as { report?: TReport | null }).report;
  }

  @syncing.action
  applyLifecycleEvent(event: LifecycleEventName): Lifecycle | null {
    const next = lifecycleEventAfter(this.state, event);
    if (next === null) return null;
    this.state = next;
    return next;
  }

  @syncing.action
  transitionState(next: Lifecycle): void {
    const from = this.state;
    if (from === next) return;
    if (!lifecycleCan(from, next)) {
      throw new PewTerminalWriteError(this, from, next);
    }
    this.state = next;
  }

  /**
   * The one durable terminal the kernel does not write: while the authorship
   * phase lasts (`declared`, no kernel write yet), the author may cancel its
   * own work — no kernel may exist yet to ask, and the alternative leaves
   * ownerless work immortal (design.md §10).
   */
  @syncing.action
  authorCancel(reason?: string): boolean {
    if (this.state !== "declared") return false;
    this.state = "cancelled";
    this.endCause = "cancel";
    if (reason !== undefined) this.endDetail = reason;
    for (const child of this.children.toReversed()) {
      child.authorCancel(reason);
    }
    return true;
  }

  /**
   * Kernel terminal write — ONE transaction: state + endCause + endDetail +
   * lastReportJson (+ product fields via applySettlement on seal). Returns
   * false on an already-terminal entity (fold races are no-ops, not errors).
   */
  @syncing.action
  applyTerminal(
    terminal: TerminalLifecycle,
    cause: EndCause,
    detail: string,
    lastReportJson: string,
    result?: TResult,
  ): boolean {
    if (isTerminal(this.state)) return false;
    this.transitionState(terminal);
    this.endCause = cause;
    this.endDetail = detail;
    this.lastReportJson = lastReportJson;
    if (terminal === "sealed" && result !== undefined) {
      try {
        this.applySettlement(result);
      } catch (error) {
        this.endDetail = `apply_error: ${String(error)}`;
      }
    }
    return true;
  }

  /** Clone copies the declaration; execution-derived fields reset — retry is a new Expectation. */
  override clone<T extends PlexusModel>(this: T, newProps: Partial<Omit<T, keyof PlexusModel>> = {}): T {
    return super.clone({
      ...newProps,
      state: "declared",
      endCause: "",
      endDetail: "",
      lastReportJson: "null",
      processorClientId: 0,
    } as Partial<Omit<T, keyof PlexusModel>>) as T;
  }
}
