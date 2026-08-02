import {
  ExpectationLoader,
  type ActorHandle,
  type ActorPresenceClient,
  type ExpectationActor,
  type IntentOutcome,
  type LaunchContext,
  type Settlement,
} from "@here.build/plexus-expectation/executor";
import invariant from "tiny-invariant";

import type { WaitUntilPort } from "./ports.js";

/**
 * DO-actor relay loader (proposal §5) — the cross-DO relay adapter. The actor
 * lives in a DIFFERENT Durable Object than the kernel; `DurableObjectLoader`
 * mints a RELAY `ActorHandle` synchronously in `spawn()` and feeds it from
 * inbound frames the transport decodes off the actor DO's wire responses.
 *
 * WHY `spawn` IS OVERRIDDEN WHOLESALE, NOT `createActor`: the base loader's
 * spawn method always routes through the in-process actor base's own
 * start/handle pair — a PROCESS-LOCAL object whose settlement/report buffers
 * live in the SAME isolate as the kernel. There is no such object here: the
 * actor runs in another DO, so the "actor" this loader hands the kernel is a
 * relay stand-in whose buffers are filled by decoded wire frames, not by
 * report/complete/fail calls made in-process. `createActor` below is
 * therefore unreachable — the base loader's own file preamble names this
 * pattern explicitly as the documented escape hatch for cross-process loaders.
 *
 * FILLED CONTRACT GAP — ctx.input MUST CARRY THE UUID: `LaunchContext` has no
 * uuid field of its own (design.md's `TInput` is "the triad's own shape," and
 * the base contract has no cross-process consumer that needs the uuid inside
 * the spawn boundary). The actor-DO id is a pure function of the Expectation
 * uuid (`deriveActorDoName`) that BOTH the kernel (to record/sweep it, in
 * `kernel.ts`, which has `E` directly) and this loader (to know where to
 * invoke, which only has `ctx`) must compute independently — no channel
 * carries it from kernel to loader. The one place `spawn(ctx)` can reach the
 * uuid is `ctx.input`, so: any Expectation subclass loaded through this class
 * MUST override its input snapshot to include the entity's own uuid (see
 * `src/__tests__/_helpers/do-test-host.ts`, the relay test triad, for the
 * pattern). This is filled silence, not a contract change — the input shape
 * is already triad-owned.
 *
 * KNOWN GAP — NO LIVE PRESENCE FOR RELAY ACTORS (named follow-up, proposal
 * §13): unlike `InProcessLoader`, this loader does not override
 * `ctx.presence`, so relay spawns flow through the kernel's null presence hub
 * and get `clientId = 0`; `RelayHandle`'s `presenceClient.setReport` is then a
 * no-op — P3 DO actors currently settle correctly but publish no live
 * progress. The fix is the same presence override `InProcessLoader` carries,
 * applied to the relay's decode sink; it changes no envelope semantics.
 */

/**
 * Deterministic actor-DO name from the Expectation uuid (proposal §5) —
 * recorded durably at spawn (`kernel.ts`'s `activate` override) so reconcile
 * can re-terminate orphans after eviction, without ever needing to ask the
 * loader or the dead actor DO what its own name was. Prefixed so names stay
 * recognizable in DO dashboards/logs — the derivation itself is a pure
 * function of the uuid, so the prefix is cosmetic, not part of the identity
 * contract (same uuid → same name is the only law).
 */
export function deriveActorDoName(expectationUuid: string): string {
  return `pew-actor:${expectationUuid}`;
}

/**
 * Inbound relay frame — decoded by the transport (fetch-RPC response body,
 * WS message, SSE event) from the actor DO's wire output. Two kinds only,
 * mirroring the two channels a real actor ever writes (design.md §5 updates +
 * settlement): everything else (control outcomes) is P3-cancel-only for v1
 * (proposal §6) and has no wire representation yet.
 */
export type RelayFrame =
  | { readonly kind: "report"; readonly report: unknown }
  | { readonly kind: "settle"; readonly settlement: Settlement<unknown> };

/** Everything the actor DO needs to (re)start its own work — opaque triad shape, carried across the invoke boundary. */
export interface ActorDoInvokeRequest {
  readonly uuid: string;
  readonly input: unknown;
}

export interface ActorDoNamespacePort {
  /**
   * Fire the actor-DO invocation. `onFrame` is the relay's decode sink: the
   * transport MUST call it synchronously, in whatever turn it decodes a
   * frame off the wire — the relay buffer law (proposal §5 G7/LC4) requires
   * no `await` between decode and the buffer mutation `onFrame` performs, so
   * a fold entered later in that turn reads the settlement/report the frame
   * just produced. The RETURNED promise is retention plumbing only (G2 spawn
   * retention) — it resolves/rejects when the underlying transport itself
   * ends (response closed, socket dropped); settlement never arrives through
   * it, matching the simplex law (no response channel carries an actor's
   * answer to another channel).
   */
  invoke(doName: string, request: ActorDoInvokeRequest, onFrame: (frame: RelayFrame) => void): Promise<void>;
  /** Fold-side hard termination of a recorded actor DO (proposal §5 orphan protocol). One-way — never awaited by a fold. */
  terminate(doName: string): Promise<void>;
}

/**
 * Deferred settlement pair, built OUTSIDE any constructor on purpose: the
 * defensive `.catch(() => {})` below (an unobserved rejection must not take
 * down the host process — mirrors the in-process actor base class's own
 * guard) is a genuine async operation, and sonarjs flags that syntactic shape
 * specifically inside a constructor body.
 */
function deferredSettlement(): {
  readonly settled: Promise<Settlement<unknown>>;
  readonly resolve: (settlement: Settlement<unknown>) => void;
  readonly reject: (reason: unknown) => void;
} {
  let doResolve!: (settlement: Settlement<unknown>) => void;
  let doReject!: (reason: unknown) => void;
  const settled = new Promise<Settlement<unknown>>((resolve, reject) => {
    doResolve = resolve;
    doReject = reject;
  });
  settled.catch(() => {});
  return { settled, resolve: doResolve, reject: doReject };
}

/**
 * The kernel-side truth for one relayed execution (design.md §6 LAST REPORT
 * LAW: "the adapter buffer IS the kernel-side truth — there is exactly one
 * buffer per handle"). `handleFrame` is called by the transport's decode
 * path; `crash` is called if the invocation's retained promise itself
 * rejects before any settlement frame ever arrived (network death, actor DO
 * eviction with no chance to emit).
 */
class RelayHandle {
  #settlement: Settlement<unknown> | null = null;
  #lastReportJson: string | null = null;
  #settledOrCrashed = false;
  readonly #resolveSettled: (settlement: Settlement<unknown>) => void;
  readonly #rejectSettled: (reason: unknown) => void;
  readonly #settled: Promise<Settlement<unknown>>;
  // P3 DO actors are cancel-only in v1 (proposal §6) — no mailbox crosses the
  // channel, so no control outcome ever arrives to feed these sinks. Kept for
  // ActorHandle interface symmetry with the in-process base class.
  readonly #outcomeSinks: ((outcome: IntentOutcome) => void)[] = [];

  constructor(private readonly presenceClient: ActorPresenceClient) {
    const deferred = deferredSettlement();
    this.#settled = deferred.settled;
    this.#resolveSettled = deferred.resolve;
    this.#rejectSettled = deferred.reject;
  }

  get clientId(): number {
    return this.presenceClient.clientID;
  }

  /** Relay buffer law (G7/LC4): called synchronously in the transport's decode turn. */
  handleFrame(frame: RelayFrame): void {
    // A late frame after settlement/crash is relay lag — accepted loss
    // (design.md §12), never a throw. Latest-frame-wins is scoped to REPORTS
    // only; a settlement is one-shot by construction (the actor DO settles
    // once, same as the in-process base class's `#settle` guard).
    if (this.#settledOrCrashed) return;
    if (frame.kind === "report") {
      let json: string;
      try {
        json = JSON.stringify(frame.report ?? null);
      } catch {
        // Malformed frame: keep the last GOOD frame (LAST REPORT LAW) — do
        // not crash the whole relay over one bad report.
        return;
      }
      this.#lastReportJson = json;
      this.presenceClient.setReport(frame.report);
      return;
    }
    this.#settledOrCrashed = true;
    this.#settlement = frame.settlement;
    this.#resolveSettled(frame.settlement);
  }

  crash(reason: unknown): void {
    if (this.#settledOrCrashed) return;
    this.#settledOrCrashed = true;
    this.#rejectSettled(reason);
  }

  handle(): ActorHandle {
    return {
      settled: this.#settled,
      clientId: this.clientId,
      settlement: () => this.#settlement,
      lastReport: () => (this.#lastReportJson === null ? null : (JSON.parse(this.#lastReportJson) as unknown)),
      onControlOutcome: (sink) => {
        this.#outcomeSinks.push(sink);
      },
    };
  }
}

/**
 * The cross-DO relay loader: sync `spawn` (handle minted immediately, invocation
 * rooted via waitUntil), one-way cancel (channel teardown, never an awaited
 * RPC), relay buffer mutated in the decode turn (proposal §5).
 */
export class DurableObjectLoader extends ExpectationLoader {
  constructor(
    private readonly ns: ActorDoNamespacePort,
    private readonly waitUntil: WaitUntilPort,
  ) {
    super();
  }

  // No bootstrap work: the namespace binding is injected at construction: idempotent no-op.
  async load(): Promise<void> {}

  protected createActor(): ExpectationActor<unknown, unknown, unknown> {
    // Unreachable — `spawn` is overridden wholesale (see class preamble).
    // `ExpectationLoader.spawn` (the base implementation) is the only caller
    // of `createActor`, and this class never calls `super.spawn(...)`.
    throw new Error("DurableObjectLoader.createActor is unreachable — spawn() is overridden wholesale");
  }

  override spawn(ctx: LaunchContext): ActorHandle {
    const input = ctx.input as { readonly uuid?: unknown };
    invariant(
      typeof input.uuid === "string" && input.uuid.length > 0,
      "DurableObjectLoader: ctx.input must carry a string `uuid` field — the DO-relayed triad's " +
        "snapshotInput() must include it (see actor-do-loader.ts preamble)",
    );
    const uuid = input.uuid;
    const doName = deriveActorDoName(uuid);

    const relay = new RelayHandle(ctx.presence.mintClient());

    // Cancel is one-way (G5): the AbortSignal is the only kernel-initiated
    // signal (SIMPLEX LAW, design.md §5) — teardown is fire-and-forget,
    // NEVER an awaited cancel RPC. Settlement preference is resolved
    // entirely off the handle buffer above, independent of this call's
    // outcome or timing.
    ctx.signal.addEventListener(
      "abort",
      () => {
        void this.ns.terminate(doName).catch(() => {});
      },
      { once: true },
    );

    // Spawn is synchronous; retention is explicit (G2): the handle is
    // minted above with no `await` yet taken, and the invocation promise is
    // handed to `waitUntil` in THIS SAME synchronous turn — an unretained
    // promise is cancellable on Workers once the activation handler returns.
    const invocation = this.ns
      .invoke(doName, { uuid, input: ctx.input }, (frame) => relay.handleFrame(frame))
      .catch((error: unknown) => relay.crash(error));
    this.waitUntil(invocation);

    return relay.handle();
  }

  /** Reconcile-side hard termination of a recorded actor-DO name (proposal §5 orphan protocol) — never trust self-termination alone. */
  terminate(doName: string): Promise<void> {
    return this.ns.terminate(doName);
  }
}
