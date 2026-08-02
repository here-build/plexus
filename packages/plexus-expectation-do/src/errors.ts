/** Thrown by every still-unimplemented stub. Carries the proposal pointer so a premature caller learns where the design lives. */
export class UnimplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not implemented — red-test frontier. ` +
        `Design: inhuman/docs/working-proposals/2026-08-03-pew-do-integration.md`,
    );
    this.name = "UnimplementedError";
  }
}
