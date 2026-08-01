/**
 * Abstract progressive durable invocation.
 *
 * Product subclasses declare a static kind (`static readonly kind = "myapp.tool_call"`);
 * access via the instance getter `E.kind`. Clone always zeros `bindEpoch` / `rebindCount`
 * (claim identity is not inherited); open or terminal.
 *
 * Live half (generator face): **one awareness base clientId per Expectation** on the
 * process hub — not CRDT, not a Progress entity. Durable half: lifecycle + children +
 * epochs + {@link processorClientId} pointer on CRDT.
 */
import { PlexusAwareness, PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { PewTerminalWriteError } from "./errors.js";
import { isTerminal, lifecycleCan, type Lifecycle } from "./lifecycle.js";
import { PROGRESS_FIELD, type ProgressMode, type ProgressPatch } from "./progress-plane.js";

type ExpectationCtor = typeof Expectation & { readonly kind: string };

@syncing("@here.build/plexus-expectation:Expectation")
export abstract class Expectation extends PlexusModel {
  /** Process hub awareness (session doc). Readers + claim owners bind this. */
  static #hub: PlexusAwareness | null = null;

  /** Local progressive clients — one base clientId per open Expectation. */
  static #live = new WeakMap<Expectation, PlexusAwareness>();

  /** Default append ring size when mode is `"append"`. */
  static appendCap = 32;

  /**
   * Bind (or clear) the process awareness hub for all Expectations.
   * Claim owners and UI peers both bind the same hub; writers use
   * {@link attachLivePresence} per Expectation.
   */
  static bindProgressHub(hub: PlexusAwareness | null): void {
    Expectation.#hub = hub;
  }

  /** Currently bound hub (hosts / tests). */
  static progressHub(): PlexusAwareness | null {
    return Expectation.#hub;
  }

  /** True if this process holds the live awareness client for `E`. */
  static hasLocalLivePresence(E: Expectation): boolean {
    return Expectation.#live.has(E);
  }

  /**
   * Mint a dedicated awareness client for this Expectation on the hub
   * (1 clientId ↔ 1 Expectation). Sets {@link processorClientId}. No-op if
   * already attached or no hub.
   */
  attachLivePresence(): void {
    const hub = Expectation.#hub;
    if (!hub || Expectation.#live.has(this)) return;
    const client = PlexusAwareness.createLocalClient(hub);
    Expectation.#live.set(this, client);
    this.processorClientId = client.clientID;
  }

  /**
   * Destroy this Expectation's awareness client and clear {@link processorClientId}.
   * Progress dies with the client (peer GC if remote).
   */
  detachLivePresence(): void {
    const client = Expectation.#live.get(this);
    if (client) {
      client.destroy();
      Expectation.#live.delete(this);
    }
    if (this.processorClientId !== 0) {
      this.processorClientId = 0;
    }
  }

  /**
   * Live progressive yield for this invocation.
   * Prefer local client; else peer at {@link processorClientId} via hub.
   */
  get progress(): ProgressPatch | undefined {
    const local = Expectation.#live.get(this);
    if (local) return readProgressField(local);

    const hub = Expectation.#hub;
    const cid = this.processorClientId;
    if (!hub || cid === 0) return undefined;
    const peer = hub.getPeer(cid) as Record<string, unknown> | null;
    if (!peer) return undefined;
    const v = peer[PROGRESS_FIELD];
    return v === undefined || v === null ? undefined : (v as ProgressPatch);
  }

  /**
   * Report a progressive yield (claim-owner path — requires local live client).
   * No-op if not attached or mode is `"none"`.
   */
  reportProgress(patch: ProgressPatch, mode: ProgressMode = "lww"): void {
    if (mode === "none") return;
    const client = Expectation.#live.get(this);
    if (!client) return;
    writeProgressField(client, patch, mode, Expectation.appendCap);
  }

  /** Drop live presence (settle, cancel, rebind, failStart). */
  clearProgress(): void {
    this.detachLivePresence();
  }

  /**
   * Kind discriminator. Concrete subclasses declare
   * `static readonly kind = "product.kind_name"`.
   * (TS 5.8 cannot combine `abstract` + `static` on fields; enforce via runtime.)
   */
  static readonly kind: string = "";

  get kind(): string {
    const k = (this.constructor as ExpectationCtor).kind;
    invariant(k, `${this.constructor.name} must declare static readonly kind`);
    return k;
  }

  @syncing accessor state: Lifecycle = "declared";
  @syncing accessor bindEpoch: number = 0;
  @syncing accessor rebindCount: number = 0;
  /**
   * Awareness base clientId of the process currently generating live progress.
   * `0` = none. Durable pointer; liveness is still awareness GC on that peer.
   */
  @syncing accessor processorClientId: number = 0;
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
      processorClientId: 0,
    } as Partial<Omit<T, keyof PlexusModel>>) as T;
  }
}

function readProgressField(client: PlexusAwareness): ProgressPatch | undefined {
  const v = client.getField(PROGRESS_FIELD as never);
  if (v === undefined || v === null) return undefined;
  return v as ProgressPatch;
}

function writeProgressField(
  client: PlexusAwareness,
  patch: ProgressPatch,
  mode: ProgressMode,
  appendCap: number,
): void {
  if (mode === "lww") {
    client.setField(PROGRESS_FIELD as never, patch as never);
    return;
  }
  const prev = client.getField(PROGRESS_FIELD as never);
  const base =
    prev === undefined || prev === null ? [] : Array.isArray(prev) ? [...prev] : [prev];
  base.push(patch);
  while (base.length > appendCap) base.shift();
  client.setField(PROGRESS_FIELD as never, base as never);
}
