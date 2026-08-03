import type { ActorHandle, ActorPresenceClient, IntentOutcome, LaunchContext, Settlement } from "./types.js";

/**
 * One execution. Writes nothing durable.
 *
 * Settlement is buffered synchronously at emit so SETTLEMENT PREFERENCE can
 * see a finished actor on the same tick as cancel. Report buffer is the last
 * JSON that serialized successfully — live object mutation after report()
 * cannot change the terminal fold. No lifecycle mirror: the durable FSM is
 * the kernel's.
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

  /** Surface fulfillments: no presence client. */
  protected readonly mintsPresence: boolean = true;

  constructor() {
    this.#settled = new Promise<Settlement<TResult>>((resolve, reject) => {
      this.#resolveSettled = resolve;
      this.#rejectSettled = reject;
    });
  }

  /** Synchronous — runs inside the activation critical section. */
  start(ctx: LaunchContext<TInput>): void {
    // Unobserved rejection must not take down the host; crash fold is the path.
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
