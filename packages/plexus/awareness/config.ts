/**
 * CONFIGURATION TYPES
 *
 * App-level configuration for awareness system
 * Set once when initializing, not per-event
 */

/**
 * App-level configuration for awareness system
 *
 * Set once when initializing, not per-event
 */
export type AwarenessConfig = {
  /**
   * How often to broadcast presence updates (milliseconds)
   *
   * Tradeoff:
   * - Lower = more responsive cursors, higher bandwidth/CPU
   * - Higher = choppier cursors, less overhead
   *
   * Recommendation: 100-200ms
   *   Fast enough for smooth cursors
   *   Slow enough to not overwhelm on 50+ concurrent users
   *
   * Note: This is BROADCAST rate, not UPDATE rate
   *   Local state updates immediately (your own cursor is always smooth)
   *   Remote state updates at this interval
   */
  tickRate: number;

  /**
   * How long with no activity before marking user as idle (milliseconds)
   *
   * "Activity" = any user input or API mutation
   *
   * Recommendation: 60000 (1 minute)
   *   Short enough to hide stale presence quickly
   *   Long enough to not mark idle during brief pauses
   *
   * Used for: dimming presence indicators, hiding cursors
   */
  idleTimeout: number;

  /**
   * How long idle users stay in presence state before removal (milliseconds)
   *
   * After this timeout, user is fully removed from presence
   * (vs just marked idle)
   *
   * Recommendation: 300000 (5 minutes)
   *
   * Why not remove immediately when idle?
   * - User might come back soon
   * - "Bob was just here 2 min ago" is useful context
   * - Reduces thrashing if user is intermittently active
   */
  cleanupTimeout: number;

  /**
   * Default transition duration for follow mode viewport changes (milliseconds)
   *
   * When following someone and they focus a new entity,
   * how long does it take to smoothly pan/zoom to that entity?
   *
   * Recommendation: align with tickRate
   *   If tickRate=150ms, transitionDuration=150ms
   *   Makes viewport sync feel synchronized with presence updates
   *
   * Can be overridden per-app for different feel
   */
  transitionDuration: number;

  /**
   * CSS timing function for follow mode transitions
   *
   * Controls easing curve for viewport animations
   *
   * Options:
   * - 'linear' = constant speed (robotic)
   * - 'ease-out' = fast start, slow end (natural)
   * - 'ease-in-out' = slow start and end (smooth)
   * - Custom cubic-bezier
   *
   * Recommendation: 'ease-out'
   *   Feels responsive (quick initial movement)
   *   Settles smoothly (no jarring stop)
   */
  transitionTiming: string;

  /**
   * Padding around focused entity in follow mode (pixels or percentage)
   *
   * When following someone's focus entity, don't frame it exactly -
   * add padding so the entity isn't at viewport edge
   *
   * number = pixels of padding on all sides
   * { top, right, bottom, left } = asymmetric padding
   * percentage = % of viewport size
   *
   * Recommendation: 50 (pixels) or '10%'
   *   Enough breathing room
   *   Not so much that entity feels small
   */
  followPadding: number | string | { top: number; right: number; bottom: number; left: number };

  /**
   * Maximum zoom out level in follow mode
   *
   * Prevents following someone who zooms out to 0.1x and making
   * your viewport uselessly zoomed out
   *
   * 1.0 = don't zoom out beyond 100%
   * 0.5 = allow zoom out to 50%
   *
   * Recommendation: 1.0
   *   You can zoom out manually if needed
   *   Follow mode keeps you at usable zoom levels
   */
  followMaxZoom: number;
};
