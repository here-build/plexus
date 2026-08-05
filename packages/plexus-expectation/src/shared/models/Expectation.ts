import { PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { type EndCause } from "../control.js";
import { PewTerminalWriteError } from "../errors.js";
import { lifecycleCan, lifecycleEventAfter, type LifecycleEventName, type Lifecycle } from "../lifecycle-machine.js";
import { isTerminal, type TerminalLifecycle } from "../lifecycle.js";

type ExpectationCtor = typeof Expectation & { readonly kind: string };

/**
 * Durable open-work unit. ONE RECORD, ONE WRITER after the kernel's first
 * durable write: host authors declaration, kernel owns envelope thereafter.
 * Progress is not here — only `processorClientId` (discovery) and terminal
 * `lastReportJson`. Prefer `pew.of(E).report` for live frames.
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

  @syncing
  accessor endCause: EndCause | "" = "";

  /**
   * Fail/cancel/crash/applySettlement diagnostic. `sealed` + non-empty =
   * partial-apply (envelope sealed, product incomplete).
   */
  @syncing
  accessor endDetail: string = "";

  /** Terminal frame; `"null"` = never reported. */
  @syncing
  accessor lastReportJson: string = "null";

  /**
   * Actor awareness client on the session hub. 0 = unassigned (PEW never mints
   * 0 — plexus-internal reservation).
   */
  @syncing
  accessor processorClientId: number = 0;

  @syncing.child.list
  accessor children: Expectation[] = [];

  snapshotInput(): unknown {
    return {};
  }

  /**
   * Seal-path product writes inside the terminal transaction. Throw does not
   * roll back the terminal — partial-apply marker lands in endDetail.
   */
  applySettlement(_result: TResult): void {}

  get lastReport(): TReport | null {
    try {
      return JSON.parse(this.lastReportJson) as TReport | null;
    } catch {
      return null;
    }
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
   * Author-held terminal while still fully `declared` (no kernel may exist
   * yet). Whole subtree must still be in authorship phase; else the kernel's
   * fold owns the tree.
   */
  @syncing.action
  authorCancel(reason?: string): boolean {
    if (!subtreeAllDeclared(this)) return false;
    const cancel = (node: Expectation): void => {
      for (const child of node.children.toReversed()) {
        cancel(child);
      }
      node.state = "cancelled";
      node.endCause = "cancel";
      if (reason !== undefined) node.endDetail = reason;
    };
    cancel(this);
    return true;
  }

  /**
   * Kernel terminal write in one action. Already-terminal → false (fold races
   * are no-ops). Settlement wrapper so `complete(undefined)` still applies.
   */
  @syncing.action
  applyTerminal(
    terminal: TerminalLifecycle,
    cause: EndCause,
    detail: string,
    lastReportJson: string,
    settlement?: { readonly result: TResult },
  ): boolean {
    if (isTerminal(this.state)) return false;
    this.transitionState(terminal);
    this.endCause = cause;
    this.endDetail = detail;
    this.lastReportJson = lastReportJson;
    if (terminal === "sealed" && settlement !== undefined) {
      try {
        this.applySettlement(settlement.result);
      } catch (error) {
        this.endDetail = `apply_error: ${String(error)}`;
      }
    }
    return true;
  }

  /** Declaration only; execution fields reset — retry is a new entity. */
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

function subtreeAllDeclared(root: Expectation): boolean {
  if (root.state !== "declared") return false;
  return root.children.every((child) => subtreeAllDeclared(child));
}
