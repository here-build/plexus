import type { ActorHandle, ActorPresenceClient, IntentOutcome, LaunchContext, Settlement } from "./types.js";

/**
 * Process-local base for one execution. The actor owns its whole output
 * surface and writes nothing durable, ever (design.md §2):
 *
 * - Updates: its own awareness client, minted at start through
 *   `ctx.presence`. Serialized at publish — a frame that fails to serialize is
 *   an actor error (crash fold) and the buffer keeps the last GOOD frame.
 *   Latest frame wins; history is the actor's own `TReport` shape.
 * - Settlement: `complete`/`fail`, buffered SYNCHRONOUSLY at emit before the
 *   promise resolves — this is what makes SETTLEMENT PREFERENCE (design.md §7)
 *   able to see a finished actor on the same tick as a cancel.
 * - Control outcomes: per-intent `considered`/`dropped`, fire-and-forget.
 *
 * Internal state is any shape the subclass wants — a state machine, a buffer,
 * an array. No lifecycle mirror exists here: the durable FSM is the kernel's
 * envelope, not the actor's concern (rejected shape, design.md §16).
 */
export abstract class ExpectationActor<TInput = unknown, TResult = unknown, TReport = unknown> {
  #client: ActorPresenceClient | null = null;
  #lastReportJson: string | null = null;
  #settlement: Settlement<TResult> | null = null;
  #crashed = false;
  #aborted = false;
  #resolveSettled!: (settlement: Settlement<TResult>) => void;
  #rejectSettled!: (reason: unknown) => void;
  readonly #settled: Promise<Settlement<TResult>>;
  readonly #outcomeSinks: ((outcome: IntentOutcome) => void)[] = [];
  readonly #pendingOutcomes: IntentOutcome[] = [];

  /** Inert actors (surface fulfillments) override to false — no presence client, clientId 0. */
  protected readonly mintsPresence: boolean = true;

  constructor() {
    this.#settled = new Promise<Settlement<TResult>>((resolve, reject) => {
      this.#resolveSettled = resolve;
      this.#rejectSettled = reject;
    });
  }

  /** Loader-invoked, synchronous (EXECUTION MODEL, design.md §7). */
  start(ctx: LaunchContext<TInput>): void {
    // A crash surfaces through the kernel's crash fold; an unobserved rejection
    // must not take down the host process.
    this.#settled.catch(() => {});
    ctx.signal.addEventListener(
      "abort",
      () => {
        this.#aborted = true;
      },
      { once: true },
    );
    if (this.mintsPresence) {
      this.#client = ctx.presence.mintClient();
    }
    try {
      const result = this.run(ctx);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => this.#crash(error));
      }
    } catch (error) {
      this.#crash(error);
    }
  }

  /** The execution. Settle via `complete`/`fail`; a throw or rejection is the crash fold. */
  protected abstract run(ctx: LaunchContext<TInput>): void | Promise<void>;

  get clientId(): number {
    return this.#client?.clientID ?? 0;
  }

  protected report(frame: TReport): void {
    if (this.#settlement !== null || this.#crashed || this.#aborted) return;
    let json: string;
    try {
      json = JSON.stringify(frame ?? null) ?? "null";
    } catch (error) {
      this.#crash(error);
      return;
    }
    // The SERIALIZED frame is the buffer (LAST REPORT LAW) — later mutation of
    // the live object cannot change what the terminal folds.
    this.#lastReportJson = json;
    this.#client?.setReport(frame);
  }

  protected complete(result: TResult): void {
    this.#settle({ outcome: "complete", result });
  }

  protected fail(reason: unknown): void {
    this.#settle({ outcome: "fail", reason });
  }

  protected outcome(intentId: string, outcome: "considered" | "dropped"): void {
    const message: IntentOutcome = { intentId, outcome };
    if (this.#outcomeSinks.length === 0) {
      this.#pendingOutcomes.push(message);
      return;
    }
    for (const sink of this.#outcomeSinks) sink(message);
  }

  #settle(settlement: Settlement<TResult>): void {
    if (this.#settlement !== null || this.#crashed) return;
    this.#settlement = settlement;
    this.#resolveSettled(settlement);
  }

  #crash(reason: unknown): void {
    if (this.#settlement !== null || this.#crashed) return;
    this.#crashed = true;
    this.#rejectSettled(reason);
  }

  handle(): ActorHandle {
    return {
      settled: this.#settled as Promise<Settlement<unknown>>,
      clientId: this.clientId,
      settlement: () => this.#settlement,
      lastReport: () => (this.#lastReportJson === null ? null : (JSON.parse(this.#lastReportJson) as unknown)),
      onControlOutcome: (sink) => {
        this.#outcomeSinks.push(sink);
        while (this.#pendingOutcomes.length > 0) {
          sink(this.#pendingOutcomes.shift()!);
        }
      },
    };
  }
}
