import { PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { type EndCause } from "../control.js";
import { PewTerminalWriteError } from "../errors.js";
import { lifecycleCan, lifecycleEventAfter, type LifecycleEventName, type Lifecycle } from "../lifecycle-machine.js";
import { isTerminal, type TerminalLifecycle } from "../lifecycle.js";

/**
 * Durable open-work unit. ONE RECORD, ONE WRITER after the kernel's first
 * durable write: host authors declaration, kernel owns envelope thereafter.
 * Progress is not here — only `processorClientId` (discovery) and terminal
 * `lastReportJson`. Prefer `pew.of(E).report` for live frames.
 *
 * The subclass is the single type carrier for its triad: input
 * (`snapshotInput` return), result (`applySettlement` argument), report
 * (`lastReport`), and the steering intents it can handle (`TIntent`).
 * Loader and actor are implementations OF this contract —
 * `ExpectationLoader<E>` / `ExpectationActor<E>` — extracted via the
 * `InputOf` / `ResultOf` / `ReportOf` / `IntentOf` helpers. Types only:
 * nothing here validates at runtime, and the kernel stays `unknown`-typed.
 */
@syncing("@here.build/plexus-expectation:Expectation")
export abstract class Expectation<TResult = unknown, TReport = unknown, TIntent = never> extends PlexusModel {
  /**
   * The kind IS the plexus registry tag (`@syncing("...")` → `modelName`),
   * derived — never declared. One naming scheme: the durable plans key, wire
   * advertisements, and process dispatch all key on the class's own identity.
   */
  static get kind(): string {
    const name = (this as unknown as { modelName?: string }).modelName;
    invariant(name, `${this.name} must be @syncing-decorated to have a kind`);
    return name;
  }

  /**
   * Phantom steering contract — never assigned, never serialized. Function-
   * typed so `TIntent` sits contravariantly: subclasses declaring intents
   * remain assignable to kernel surfaces typed plain `Expectation`
   * (whose default is `never`).
   */
  declare readonly __intent__?: (intent: TIntent) => void;

  get kind(): string {
    return (this.constructor as typeof Expectation).kind;
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

/**
 * The constraint that admits every triad instantiation. The intent slot must
 * be `never`, not `any`: the phantom is contravariant, so `(T) => void` is
 * assignable to `(never) => void` for all T, while `any` there admits nothing.
 */
export type AnyExpectation = Expectation<any, any, never>;

/** Structural extraction — reads the subclass's own overrides, so a narrowed
 * `snapshotInput` return types the triad even without re-declaring generics. */
export type InputOf<E extends AnyExpectation> = ReturnType<E["snapshotInput"]>;
export type ResultOf<E extends AnyExpectation> = Parameters<E["applySettlement"]>[0];
export type ReportOf<E extends AnyExpectation> = Exclude<E["lastReport"], null>;
export type IntentOf<E extends AnyExpectation> = Parameters<NonNullable<E["__intent__"]>>[0];
