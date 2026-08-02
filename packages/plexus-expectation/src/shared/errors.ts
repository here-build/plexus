export class PewTerminalWriteError extends Error {
  public readonly name = "PewTerminalWriteError";

  constructor(
    public readonly entity: object,
    public readonly from: string,
    public readonly to: string,
  ) {
    const label =
      "kind" in entity && typeof entity.kind === "string" ? entity.kind : (entity.constructor?.name ?? "entity");
    super(`PewTerminalWriteError: cannot transition ${from} → ${to} (${label})`);
  }
}
