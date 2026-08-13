/**
 * Stage-3 decorator context — same predicate as MobX `is20223Decorator`
 * (mobx `api/decorators.ts`): an object with a string `kind`.
 *
 * Stage-2 / `experimentalDecorators` invoke `(target, key)` or `(ctor)`
 * and have no `kind`. `@syncing` field construction is the accessor `init`
 * hook; stage-2 has no `init`. Throw at the decorator call, not later.
 */
import invariant from "tiny-invariant";

export const STAGE2_DECORATORS_UNSUPPORTED =
  "@syncing: stage-2 decorators are unsupported; stage-3 is required (experimentalDecorators must be off)";

export function isStage3DecoratorContext(context: unknown): context is DecoratorContext {
  return typeof context === "object" && context !== null && typeof (context as { kind?: unknown }).kind === "string";
}

export function assertStage3Decorator(context: unknown): asserts context is DecoratorContext {
  invariant(isStage3DecoratorContext(context), STAGE2_DECORATORS_UNSUPPORTED);
}
