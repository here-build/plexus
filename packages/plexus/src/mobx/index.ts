/**
 * Compatibility entry. MobX field tracking is always on in `@here.build/plexus`;
 * calling {@link enableMobXIntegration} is a no-op.
 */

/** Always true — atoms are minted from the first field read. */
export const isGlobalIntegrationEnabled = true;

/** No-op. Kept so existing `import { enableMobXIntegration }` call sites compile. */
export const enableMobXIntegration = (): void => {};
