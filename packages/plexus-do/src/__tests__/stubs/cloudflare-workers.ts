/** Node vitest stub — enough to construct DO subclasses outside workerd. */

export class DurableObject<E = unknown> {
  protected ctx: DurableObjectState;
  protected env: E;

  constructor(ctx: DurableObjectState, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}