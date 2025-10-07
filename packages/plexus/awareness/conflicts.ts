/**
 * CONFLICT DETECTION TYPES
 *
 * Types for detecting and handling concurrent operation conflicts
 */

import type { EntityId, UserId } from './types';

/**
 * Conflict event fired when operations overlap
 *
 * "Conflict" = two users operating on same entity simultaneously
 *
 * When fired:
 * - Both users dragging same element
 * - Both users editing same property
 * - User deletes what another is focused on
 *
 * NOT fired for:
 * - Different entities (obviously)
 * - Same entity, different aspects (edit backgroundColor vs position)
 * - One user browsing while other edits (focus != operation)
 */
export type ConflictEvent = {
  /**
   * What kind of conflict?
   *
   * 'soft' = potential issue, but not critical
   *   Example: both focusing same entity
   *   Action: show notification, let both continue
   *
   * 'medium' = likely to cause issues
   *   Example: both dragging same element
   *   Action: show warning, last write wins
   *
   * 'hard' = definitely problematic
   *   Example: one deletes what other is editing
   *   Action: block deletion, show error
   */
  severity: 'soft' | 'medium' | 'hard';

  /**
   * Your operation that's conflicting
   */
  yourOperation: {
    type: string;
    entities: EntityId[];
    startedAt: number;
  };

  /**
   * Other user's operation that conflicts
   */
  theirOperation: {
    type: string;
    entities: EntityId[];
    startedAt: number;
    userId: UserId;
  };

  /**
   * Which entities are involved in conflict
   */
  conflictingEntities: EntityId[];

  /**
   * Human-readable description
   *
   * Example: "Alice is also editing Button_X"
   */
  message: string;

  /**
   * When conflict was detected
   */
  timestamp: number;
};

/**
 * Subscribe to conflict events
 *
 * Usage:
 *   useConflictDetection((conflict) => {
 *     if (conflict.severity === 'hard') {
 *       showError(conflict.message);
 *       cancelMyOperation();
 *     } else {
 *       showWarning(conflict.message);
 *     }
 *   });
 *
 * Fires when your current operation conflicts with someone else's
 */
export type UseConflictDetection = (callback: (conflict: ConflictEvent) => void) => void;

/**
 * Check if an operation would conflict before starting it
 *
 * Usage:
 *   const checkConflict = useConflictCheck();
 *   const conflict = checkConflict({
 *     type: 'delete',
 *     entities: ['Button_X']
 *   });
 *   if (conflict) {
 *     showWarning(conflict.message);
 *     // Maybe cancel the delete
 *   }
 *
 * Returns null if no conflict, ConflictEvent if conflict detected
 */
export type UseConflictCheck = () => (operation: { type: string; entities: EntityId[] }) => ConflictEvent | null;
