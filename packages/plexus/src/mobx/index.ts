/**
 * Compatibility entry. MobX field tracking is unconditional (see tracking.ts),
 * so both exports here are inert — they exist only to keep call sites that
 * still import the old opt-in switch compiling.
 */

export const isGlobalIntegrationEnabled = true;

export const enableMobXIntegration = (): void => {};
