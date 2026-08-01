/**
 * Terminal / illegal transition barrier for durable PEW state writes.
 */

/**
 * Illegal lifecycle transition (Expectation state or Adjustment consumption).
 * Use named writers (`transitionState` / `transitionConsumption`).
 */
export class PewTerminalWriteError extends Error {
  public readonly name = "PewTerminalWriteError";

  constructor(
    public readonly entity: object,
    public readonly from: string,
    public readonly to: string,
  ) {
    const label =
      "kind" in entity && typeof (entity as { kind: unknown }).kind === "string"
        ? (entity as { kind: string }).kind
        : entity.constructor?.name ?? "entity";
    super(`PewTerminalWriteError: cannot transition ${from} → ${to} (${label})`);
  }
}
