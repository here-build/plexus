/**
 * Abstract durable work unit (§3.1).
 *
 * Product subclasses (e.g. `harness.tool_call`) live in harness-model and declare:
 *   static readonly kind = "harness.tool_call"
 * Access kind via the instance getter `E.kind` or the constructor static.
 *
 * Clone law: non-terminal Expectations refuse clone (`PewCloneOpenError`).
 * Terminal clone goes through Plexus `clone` and zeros `bindEpoch` / `rebindCount`.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import { PewCloneOpenError, PewTerminalWriteError } from "./errors.js";
import { isOpen, isTerminal, type Lifecycle } from "./lifecycle.js";

type ExpectationCtor = typeof Expectation & { readonly kind: string };

@syncing("@here.build/plexus-expectation:Expectation")
export abstract class Expectation extends PlexusModel {
  /**
   * Kind discriminator. Concrete subclasses declare
   * `static readonly kind = "product.kind_name"` (e.g. `"harness.tool_call"`).
   * (TS 5.8 cannot combine `abstract` + `static` on fields; enforce via runtime.)
   */
  static readonly kind: string = "";

  /** Instance view of the constructor's static kind. */
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
   */
  @syncing.action
  transitionState(next: Lifecycle): void {
    const from = this.state;
    if (from === next) return;
    if (isTerminal(from)) {
      throw new PewTerminalWriteError(this, from, next);
    }
    this.state = next;
  }

  /**
   * Plexus clone hook: open work cannot be snapshotted.
   * On success, forces `bindEpoch=0` / `rebindCount=0` on the clone (source unchanged).
   */
  override clone<T extends PlexusModel>(
    this: T,
    newProps: Partial<Omit<T, keyof PlexusModel>> = {},
  ): T {
    assertCloneable(this as unknown as Expectation);
    return super.clone({
      ...newProps,
      // Spec §3.1: terminal clone resets claim/rebind counters.
      bindEpoch: 0,
      rebindCount: 0,
    } as Partial<Omit<T, keyof PlexusModel>>) as T;
  }
}

/**
 * Reject if `E` or any owned descendant is non-terminal.
 * Product hosts that clone a larger root containing Expectations should call this
 * (or rely on `Expectation.clone`, which invokes it per Expectation node).
 */
export function assertCloneable(E: Expectation): void {
  if (isOpen(E.state)) {
    throw new PewCloneOpenError(E);
  }
  for (const child of E.children) {
    assertCloneable(child);
  }
}
