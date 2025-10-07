/**
 * PLEXUS AWARENESS API
 *
 * Semantic collaboration across incompatible interface modalities
 *
 * Core principle: Track WHAT (entity) and WHY (operation), not WHERE (pixels)
 * Spatial data is optional and modality-specific
 *
 * @example
 * // Visual builder
 * <ViewportSegment id="canvas">
 *   <PresenceBoundary entityId="Button_X">
 *     <button>Click me</button>
 *   </PresenceBoundary>
 * </ViewportSegment>
 *
 * @example
 * // Get presence for entity
 * const presence = usePresenceInEntity('Button_X');
 * // presence.users = all users engaged with this entity
 *
 * @example
 * // Update your presence
 * const updatePresence = useUpdatePresence();
 * updatePresence({ focus: 'Button_X' });
 *
 * @example
 * // Follow mode
 * const { startFollowing, stopFollowing } = useFollowMode();
 * startFollowing('alice');
 */

// Core types
export type { PresenceState, Span, EntityId, UserId } from './types';

// Configuration
export type { AwarenessConfig } from './config';

// React components
export type { PresenceBoundaryProps, ViewportSegmentProps, PresenceInfo } from './components';

// React hooks
export type {
  UsePresenceInEntity,
  UsePresenceInSegment,
  UseAllPresence,
  UseMyPresence,
  UseUpdatePresence,
  UseFollowMode,
  UseFollowers,
} from './hooks';

// Conflict detection
export type { ConflictEvent, UseConflictDetection, UseConflictCheck } from './conflicts';
