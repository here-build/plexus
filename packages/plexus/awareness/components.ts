/**
 * REACT COMPONENT TYPES
 *
 * Declarative API for defining semantic boundaries and viewport segments
 */

import type { EntityId, UserId } from './types';

/**
 * Information about presence for a specific entity
 *
 * Provided to PresenceBoundary render functions and callbacks
 */
export type PresenceInfo = {
  /**
   * All users currently engaged with this entity
   *
   * "Engaged" = focused, selected, pointing at, or operating on
   *
   * Sorted by engagement type:
   * 1. Active operations (dragging, editing)
   * 2. Focus
   * 3. Selection
   * 4. Pointer hover
   */
  users: Array<{
    userId: UserId;
    sessionId: string;
    appType: string;
    engagementType: 'operation' | 'focus' | 'selection' | 'pointer';
    operation?: string; // If engaged via active operation
  }>;

  /**
   * Is this entity focused by any user?
   */
  isFocused: boolean;

  /**
   * Is this entity selected by any user?
   */
  isSelected: boolean;

  /**
   * Is any user pointing at this entity?
   */
  hasPointer: boolean;

  /**
   * What operations are currently active on this entity?
   *
   * Examples: ['drag', 'resize'], ['property-edit'], []
   */
  activeOperations: string[];
};

/**
 * React component props for declaring semantic entity boundaries
 *
 * Wraps UI elements to declare "this represents entity X"
 * Enables the system to map semantic presence to spatial rendering
 *
 * Example:
 *   <PresenceBoundary entityId="Button_X">
 *     <button>Click me</button>
 *   </PresenceBoundary>
 *
 * When another user has focus="Button_X":
 * - Visual builder: highlight this boundary
 * - Show "Alice is editing this" tooltip
 * - Render Alice's cursor if she's in same segment
 */
export type PresenceBoundaryProps = {
  /**
   * Which semantic entity does this UI element represent?
   *
   * This creates the mapping:
   *   presence.focus = "Button_X" → highlight this boundary
   *
   * Can be used multiple times for same entity
   * (entity appears in tree view AND canvas view)
   * Both boundaries highlight when entity is focused
   */
  entityId: EntityId;

  /**
   * Which segment is this boundary part of?
   *
   * Defaults to nearest ViewportSegment ancestor
   *
   * Override when boundary exists in different segment than parent
   * (rare, but possible in complex layouts)
   */
  segment?: string;

  /**
   * Render prop for presence-aware styling
   *
   * Instead of just children, can be function receiving presence data:
   *   (presenceInfo) => ReactNode
   *
   * presenceInfo = {
   *   users: User[],           // Users engaged with this entity
   *   isFocused: boolean,      // Any user has this focused
   *   isSelected: boolean,     // Any user has this selected
   *   hasPointer: boolean,     // Any user pointing at this
   *   activeOperations: string[] // Operations affecting this entity
   * }
   *
   * Enables custom rendering based on presence:
   *   <PresenceBoundary entityId="Button_X">
   *     {({ isFocused, users }) => (
   *       <div className={isFocused ? 'highlighted' : ''}>
   *         {users.length > 0 && <UserBadge users={users} />}
   *         <Button />
   *       </div>
   *     )}
   *   </PresenceBoundary>
   */
  children: React.ReactNode | ((presenceInfo: PresenceInfo) => React.ReactNode);

  /**
   * Callback when presence changes for this entity
   *
   * Fired when any user's presence affects this entity:
   * - User focuses this entity
   * - User unfocuses this entity
   * - User starts operation on this entity
   * - User's cursor enters/leaves this entity
   *
   * Used for: custom effects, logging, analytics
   */
  onPresenceChange?: (presenceInfo: PresenceInfo) => void;
};

/**
 * React component props for declaring viewport segments
 *
 * Wraps a UI region to declare "this is segment X"
 * Enables segment-specific spatial rendering of presence
 *
 * Example:
 *   <ViewportSegment id="canvas">
 *     {/* Canvas UI with entity boundaries inside *\/}
 *   </ViewportSegment>
 */
export type ViewportSegmentProps = {
  /**
   * Unique identifier for this segment
   *
   * Used in presence.activeSegment and presence.pointer.segment
   * to identify where users are
   *
   * Examples: "canvas", "tree", "code", "inspector"
   */
  id: string;

  /**
   * Child elements (usually contains PresenceBoundary components)
   */
  children: React.ReactNode;

  /**
   * How to render cursors in this segment
   *
   * undefined = use default cursor rendering
   * custom = provide your own cursor rendering logic
   *
   * Custom cursor renderer receives:
   * - users: who has pointers in this segment
   * - segment coordinate system
   * - segment dimensions
   *
   * Returns: cursor elements to render
   */
  renderCursors?: (info: {
    users: Array<{
      userId: UserId;
      coords: [number, number];
      type: 'mouse' | 'touch' | 'pen';
      entity: EntityId | null;
    }>;
    segmentBounds: DOMRect;
  }) => React.ReactNode;

  /**
   * How to transform viewport coordinates
   *
   * Canvas has zoom/pan transforms
   * Code view has scroll transforms
   * Tree view might not have transforms
   *
   * Used for: rendering cursors at correct visual position
   *
   * Example canvas transform:
   *   (coords) => {
   *     const [worldX, worldY] = coords;
   *     const screenX = (worldX - panX) * zoom;
   *     const screenY = (worldY - panY) * zoom;
   *     return [screenX, screenY];
   *   }
   */
  coordTransform?: (coords: [number, number]) => [number, number];
};
