/**
 * REACT HOOK TYPES
 *
 * Type definitions for awareness hooks
 */

import type { EntityId, PresenceState, UserId } from './types';
import type { PresenceInfo } from './components';

/**
 * Get presence information for a specific entity
 *
 * Usage:
 *   const presence = usePresenceInEntity('Button_X');
 *   // presence.users = all users engaged with Button_X
 *   // presence.isFocused = is anyone focusing it?
 *
 * Re-renders when presence for this entity changes
 */
export type UsePresenceInEntity = (entityId: EntityId) => PresenceInfo;

/**
 * Get presence information for current segment
 *
 * Usage:
 *   const presence = usePresenceInSegment('canvas');
 *   // presence.users = all users in canvas segment
 *   // presence.pointers = all cursor positions
 *
 * Re-renders when anyone enters/leaves/moves in segment
 */
export type UsePresenceInSegment = (segmentId: string) => {
  users: PresenceState[];
  pointers: Array<{
    userId: UserId;
    coords: [number, number];
    entity: EntityId | null;
    type: 'mouse' | 'touch' | 'pen';
  }>;
};

/**
 * Get all active presence states
 *
 * Usage:
 *   const allUsers = useAllPresence();
 *   // allUsers = array of all PresenceState objects
 *
 * Re-renders on any presence change (expensive, use sparingly)
 *
 * Use cases:
 * - User list in sidebar
 * - Overview map showing all users
 * - Analytics/monitoring
 */
export type UseAllPresence = () => PresenceState[];

/**
 * Get your own presence state
 *
 * Usage:
 *   const myPresence = useMyPresence();
 *   // myPresence.focus = what I'm focused on
 *   // myPresence.following = who I'm following
 *
 * Re-renders when your own presence changes
 */
export type UseMyPresence = () => PresenceState;

/**
 * Update your presence state
 *
 * Usage:
 *   const updatePresence = useUpdatePresence();
 *   updatePresence({ focus: 'Button_X' });
 *   updatePresence({ selection: [{ entity: 'Button_Y' }] });
 *
 * Partial updates - only changes specified fields
 * Batches multiple updates within same tick
 */
export type UseUpdatePresence = () => (updates: Partial<PresenceState>) => void;

/**
 * Follow another user
 *
 * Usage:
 *   const { startFollowing, stopFollowing, isFollowing } = useFollowMode();
 *   startFollowing('alice');
 *   // Now your viewport syncs to Alice's focus
 *   stopFollowing();
 *
 * When following:
 * - Viewport auto-pans to their focus entity
 * - Optionally switches segments when they switch
 * - Auto-unfollows on local navigation (or configurable)
 */
export type UseFollowMode = () => {
  startFollowing: (userId: UserId) => void;
  stopFollowing: () => void;
  isFollowing: boolean;
  followingUserId: UserId | null;
};

/**
 * Get users following you
 *
 * Usage:
 *   const followers = useFollowers();
 *   // followers = ['alice', 'bob']
 *
 * Re-renders when someone starts/stops following you
 */
export type UseFollowers = () => UserId[];
