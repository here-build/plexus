import type { ActorHandle, ActorPresenceClient, LaunchContext, Settlement } from "./types.js";
import type { Expectation, ReportOf, ResultOf } from "../shared/models/Expectation.js";

/**
 * One execution, bound to the expectation contract it fulfills: report frames
 * are `ReportOf<E>`, settlement is `ResultOf<E>`, the mailbox is `IntentOf<E>`.
 * Writes nothing durable.
 *
 * Settlement is buffered synchronously at emit so SETTLEMENT PREFERENCE can
 * see a finished actor on the same tick as cancel. Report buffer is the last
 * JSON that serialized successfully — live object mutation after report()
 * cannot change the terminal fold. No lifecycle mirror: the durable FSM is
 * the kernel's.
 */

export abstract class ExpectationActor<E extends Expectation<any, any, never> = Expectation> {
  #client: ActorPresenceClient | null = null;
  #lastReportJson: string | null = null;
  #settlement: Settlement<ResultOf<E>> | null = null;
  #crashed = false;
  #aborted = false;
  #resolveSettled!: (settlement: Settlement<ResultOf<E>>) => void;
  #rejectSettled!: (reason: unknown) => void;
  readonly #settled: Promise<Settlement<ResultOf<E>>>;

  /** Surface fulfillments: no presence client. */
  protected readonly mintsPresence: boolean = true;

  constructor() {
    this.#settled = new Promise<Settlement<ResultOf<E>>>((resolve, reject) => {
      this.#resolveSettled = resolve;
      this.#rejectSettled = reject;
    });
  }

  /** Synchronous — runs inside the activation critical section. */
  start(ctx: LaunchContext<E>): void {
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

  protected abstract run(ctx: LaunchContext<E>): void | Promise<void>;

  get clientId(): number {
    return this.#client?.clientID ?? 0;
  }

  protected report(frame: ReportOf<E>): void {
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

  protected complete(result: ResultOf<E>): void {
    this.#settle({ outcome: "complete", result });
  }

  protected fail(reason: unknown): void {
    this.#settle({ outcome: "fail", reason });
  }

  #settle(settlement: Settlement<ResultOf<E>>): void {
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
    };
  }
}
