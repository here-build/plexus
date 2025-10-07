/**
 * CORE PRESENCE TYPES
 *
 * Goal: Enable semantic collaboration across incompatible interface modalities
 * (visual builder, MCP, CLI, mobile, future unknown apps)
 *
 * Core principle: Track WHAT (entity) and WHY (operation), not WHERE (pixels)
 * Spatial data is optional and modality-specific
 */

export type EntityId = string;
export type UserId = string;

/**
 * The complete presence state for a single user session.
 *
 * This gets broadcast to all other users at a regular tick rate (e.g. 150ms).
 * Each application modality interprets this state differently:
 * - Visual builder: renders cursors, highlights, operation badges
 * - MCP: uses for conflict avoidance and context
 * - Code view: highlights affected lines, shows collaboration indicators
 *
 * State is MINIMAL - only what's needed for awareness, not full user state.
 * The CRDT (Plexus) handles the actual data model - this is just "where are people"
 */
export type PresenceState = {
  // -------------------------------------------------------------------------
  // IDENTITY
  // Who is this? What kind of app are they using?
  // -------------------------------------------------------------------------

  /**
   * Unique identifier for the user (persists across sessions)
   * Used for: attribution, follow mode, conflict detection
   */
  userId: string;

  /**
   * Unique identifier for this specific session/tab
   * Used for: distinguishing multiple tabs from same user
   * Example: User has visual builder in one tab, code view in another
   */
  sessionId: string;

  /**
   * What kind of application is this session?
   *
   * Used for rendering presence appropriately:
   * - AI presence might not show a cursor
   * - CLI presence might show command indicators
   * - Mobile might have different spatial semantics
   *
   * Can be arbitrary string - apps define their own types
   */
  appType: 'visual-builder' | 'mcp' | 'cli' | 'mobile' | string;

  // -------------------------------------------------------------------------
  // ACTIVITY LIFECYCLE
  // Is this person actually here? Are they doing anything?
  // -------------------------------------------------------------------------

  /**
   * Is the browser tab/application currently focused?
   *
   * false = user switched tabs or minimized window
   * true = tab is active (but user might still be idle)
   *
   * Used for: dimming presence indicators, showing "user stepped away"
   * Triggered by: window blur/focus events
   */
  isActive: boolean;

  /**
   * Has there been no interaction for some timeout period?
   *
   * false = recent activity (mouse, keyboard, touch, API calls)
   * true = no activity for N seconds (configurable, maybe 60s+)
   *
   * Used for: showing "idle" status, hiding cursors, dimming highlights
   * Note: isActive=true + isIdle=true = "tab focused but user AFK"
   */
  isIdle: boolean;

  /**
   * Timestamp of last activity (any interaction)
   *
   * Used for: calculating idle duration, sorting "recently active" users
   * Updates on: any user input, any API mutation, any navigation
   */
  lastActivity: number;

  // -------------------------------------------------------------------------
  // NAVIGATION STATE
  // What document/segment are they in?
  // -------------------------------------------------------------------------

  /**
   * Which document within the Plexus root are they viewing?
   *
   * undefined = viewing the same document as before (default case)
   * string = switched to a different document
   *
   * Example: User switches from "Homepage" project to "Dashboard" project
   * within the same workspace. Other users see "User switched to Dashboard"
   * and can optionally follow them there.
   *
   * This is DIFFERENT from switching to a completely different website -
   * this is switching between documents that share the same Plexus root.
   */
  activeDocument?: string;

  /**
   * Which UI segment/view has focus in this app?
   *
   * Segment = distinct UI space with its own spatial coordinate system
   * Examples in visual builder:
   * - "canvas" = main artboard view
   * - "tree" = component hierarchy tree
   * - "code" = code editor view
   * - "inspector" = properties panel
   *
   * Examples in MCP (might be operation types instead of UI spaces):
   * - "read" = querying entities
   * - "edit" = mutating properties
   * - "generate" = creating new entities
   *
   * Used for: knowing where to render spatial presence (cursor, viewport)
   * Cross-segment: visual builder user in "canvas", code view user in "code"
   *   both focused on same entity - show entity highlight in both segments
   */
  activeSegment: string;

  // -------------------------------------------------------------------------
  // SEMANTIC STATE
  // What entity/entities are they working with?
  // This is the CORE of semantic presence - everything else is supplementary
  // -------------------------------------------------------------------------

  /**
   * The primary entity that has this user's attention
   *
   * null = no specific focus (e.g. viewing empty canvas, idle state)
   * EntityId = actively engaged with this entity
   *
   * Examples:
   * - Visual builder: clicked on a button → focus = Button_X
   * - Code view: cursor in component definition → focus = Component_Y
   * - MCP: analyzing entity properties → focus = Entity_Z
   * - Tree view: selected node → focus = Node_W
   *
   * Used for:
   * - Showing "User is looking at this" highlights
   * - Conflict detection: "Don't delete what someone's focused on"
   * - Follow mode: center viewport on their focus entity
   *
   * Note: focus is SEPARATE from selection
   * You can focus Button_X while having multiple things selected
   */
  focus: EntityId | null;

  /**
   * The entity or entities currently selected for manipulation
   *
   * Empty array = nothing selected
   * Single item = one entity selected
   * Multiple items = multi-selection (e.g. shift+click in visual builder)
   *
   * Each selection item has:
   * - entity: which semantic entity (required)
   * - span: optional metadata about WHAT PART of the entity (optional)
   *
   * Span examples:
   * - Text editor: { start: 10, end: 20 } = characters 10-20 selected
   * - MCP: { property: "backgroundColor" } = editing this specific property
   * - List view: { items: [0, 2, 4] } = selected items at these indices
   * - Code view: { lines: { start: 50, end: 60 } } = line range
   *
   * Used for:
   * - Showing selection highlights across different views
   * - Conflict detection: "Both users editing same property"
   * - Multi-entity operations: "User about to delete these 3 things"
   *
   * Note: selection can include focused entity but doesn't have to
   * Example: focus=Container_A, selection=[Button_X, Button_Y, Button_Z]
   *   (selected children while focused on parent)
   */
  selection: Array<{
    entity: EntityId;
    span?: Span;
  }>;

  /**
   * Text cursor position (separate from selection)
   *
   * undefined = no text caret (not in text editing mode)
   * defined = actively editing text within an entity
   *
   * Why separate from selection?
   * - Selection can be multi-entity, caret is always single position
   * - Can have selection + caret simultaneously (selected text range + cursor)
   * - Different modalities: visual builder rarely has caret, code view always does
   *
   * Example: Editing button label
   *   focus = Button_X
   *   selection = [{ entity: Button_X, span: { text: { start: 0, end: 5 } } }]
   *   caret = { entity: Button_X, position: { offset: 5 } }
   *
   * Used for: showing blinking cursor in text fields across modalities
   */
  caret?: {
    entity: EntityId;
    position: Span;
  };

  // -------------------------------------------------------------------------
  // ACTIVE OPERATION
  // What are they currently DOING? (for conflict detection)
  // -------------------------------------------------------------------------

  /**
   * Currently active interaction/operation
   *
   * undefined = no active operation (idle, browsing, just viewing)
   * defined = user is in the middle of something temporal
   *
   * "Temporal" = operation that has start/end, not just instantaneous action
   * Examples:
   * - Dragging elements (start = mousedown, end = mouseup)
   * - Resizing (start = grab handle, end = release)
   * - Text editing session (start = focus input, end = blur)
   * - AI generation (start = request sent, end = response complete)
   *
   * Used for conflict detection during "soft transactions":
   * - If Alice is dragging Button_X and Bob tries to delete it → warn Bob
   * - If AI is editing properties while user restructures → last write wins
   * - If user is in text edit session → don't apply remote text changes yet
   *
   * type = arbitrary string, app-defined
   *   Visual builder: "drag", "resize", "draw", "text-edit"
   *   MCP: "property-edit", "generate", "restructure"
   *   Code view: "text-edit", "refactor", "format"
   *
   * entities = which entities are affected by this operation
   *   Used for: "don't touch these entities, user is actively manipulating"
   *
   * startedAt = when operation began (for timeout detection)
   *   Used for: detecting stuck operations, showing "operation in progress" duration
   */
  interaction?: {
    type: string;
    entities: EntityId[];
    startedAt: number;
  };

  // -------------------------------------------------------------------------
  // SPATIAL STATE (Optional - only meaningful for spatial modalities)
  // Visual builder has this, MCP doesn't, code view has different semantics
  // -------------------------------------------------------------------------

  /**
   * Pointer position within the current segment
   *
   * undefined = no pointer (AI/API access, or touch released)
   * defined = pointer currently exists in segment
   *
   * Why optional?
   * - AI via MCP has no cursor
   * - Touch input: pointer exists during touch, disappears after release
   * - Mouse input: pointer always exists while in segment
   * - Some app types might not have spatial concept at all
   *
   * segment = which UI space this pointer is in
   *   Must match activeSegment? Not necessarily:
   *   - activeSegment = "tree" (keyboard focused)
   *   - pointer.segment = "canvas" (mouse hovering)
   *
   * entity = what semantic entity is under the pointer (if any)
   *   null = pointing at empty space, UI chrome, etc.
   *   EntityId = hovering over this entity
   *   Used for: showing hover highlights, tooltip previews
   *
   * coords = position within segment's coordinate system
   *   undefined = no meaningful coordinates (e.g. tree view selection)
   *   [x, y] = position in segment space
   *   NOTE: Coordinate system is segment-specific:
   *   - Canvas: world coordinates (accounts for zoom/pan)
   *   - Code view: line/column numbers
   *   - Tree view: might not have coords at all
   *
   * type = what kind of pointer is this?
   *   'mouse' = cursor stays visible, shows on others' screens
   *   'touch' = finger, disappears after release (don't render stale touch)
   *   'pen' = stylus, might have pressure/tilt (future: richer data?)
   */
  pointer?: {
    segment: string;
    entity: EntityId | null;
    coords?: [number, number];
    type: 'mouse' | 'touch' | 'pen';
  };

  /**
   * Viewport state for this segment (optional, for follow mode)
   *
   * undefined = don't broadcast viewport (saves bandwidth, most common case)
   * defined = broadcast viewport so others can follow you
   *
   * Why optional?
   * - Most of the time, others don't need your viewport
   * - Only needed when someone is actively following you
   * - Or for showing "overview map" with all users' viewports
   *
   * Only set this if:
   * - You have followers (someone in follow mode on you)
   * - App wants to show viewport rectangles on overview map
   *
   * Structure is intentionally loose - different segments have different viewport concepts:
   * - Canvas: { center: [x, y], zoom: 1.5, rotation: 0 }
   * - Code view: { scrollTop: 500, visibleLines: [20, 50] }
   * - Tree view: { expandedNodes: [...], scrollOffset: 100 }
   *
   * Each segment defines its own viewport shape
   */
  viewport?: Record<string, unknown>;

  // -------------------------------------------------------------------------
  // FOLLOW MODE
  // Are you following someone? Is someone following you?
  // -------------------------------------------------------------------------

  /**
   * User ID of person you're currently following
   *
   * undefined = not following anyone (normal mode)
   * string = actively following this user
   *
   * When following:
   * - Your viewport syncs to their focus entity (with padding/transitions)
   * - Their navigation events might auto-switch your view
   * - You see "Following Alice" indicator
   *
   * Following is ONE-WAY:
   * - You follow Alice (you see her state)
   * - Alice sees "User following you" notification
   * - Alice doesn't automatically follow you back
   *
   * Breaking follow mode:
   * - Explicit unfollow action
   * - You manually pan/zoom (auto-unfollow on local navigation)
   * - They switch documents (you get prompt: "Alice switched docs, follow?")
   * - They go idle/inactive (auto-unfollow? or pause?)
   */
  following?: UserId;

  /**
   * List of users currently following you
   *
   * undefined/empty = no one following
   * [userId1, userId2] = these users are following you
   *
   * Used for:
   * - Showing "2 people following you" indicator
   * - Deciding whether to broadcast viewport (only if followers exist)
   * - UI consideration: "people are watching, be thoughtful"
   *
   * Derived from other users' presence.following fields
   * (Not directly set by you - the system populates this)
   */
  followers?: UserId[];
};

/**
 * Metadata about WHAT PART of an entity is selected/focused
 *
 * Different modalities need different span types:
 * - Text editing: character ranges
 * - Property editing: specific property path
 * - List selection: item indices
 * - Code editing: line ranges, AST nodes
 * - Visual selection: maybe geometric bounds?
 *
 * Apps can define their own span types beyond these
 */
export type Span =
  /**
   * Text character range (most common)
   *
   * Used in: text inputs, rich text editors, code editors
   *
   * start = offset of first selected character (0-indexed)
   * end = offset of character AFTER last selected character
   *   (standard text range semantics: [start, end))
   *
   * Example: "Hello World"
   *   span { start: 0, end: 5 } = "Hello"
   *   span { start: 6, end: 11 } = "World"
   */
  | { type: 'text'; start: number; end: number }

  /**
   * Discrete item selection (non-contiguous)
   *
   * Used in: lists, grids, multi-select dropdowns
   *
   * indices = which items are selected
   *   NOT necessarily contiguous
   *   NOT necessarily sorted
   *
   * Example: list of 10 items
   *   span { indices: [0, 2, 7] } = first, third, and eighth items
   */
  | { type: 'items'; indices: number[] }

  /**
   * Contiguous range of items
   *
   * Used in: selecting multiple list items, table rows, timeline ranges
   *
   * start = first selected index
   * end = last selected index (INCLUSIVE, unlike text spans)
   *
   * Example: list of 10 items
   *   span { start: 2, end: 5 } = items 2, 3, 4, 5
   *
   * Why separate from items?
   * - More efficient for large ranges
   * - Different UX semantics (shift+click vs cmd+click)
   */
  | { type: 'range'; start: number; end: number }

  /**
   * Property path within entity
   *
   * Used in: MCP property editing, inspector panels
   *
   * path = dot-notation path to property
   *   Examples:
   *   - "backgroundColor"
   *   - "style.padding.left"
   *   - "children[2].props.text"
   *
   * Enables fine-grained conflict detection:
   * - Alice editing Button_X.backgroundColor
   * - Bob editing Button_X.borderRadius
   * - No conflict! Different properties
   */
  | { type: 'property'; path: string }

  /**
   * Line range in code
   *
   * Used in: code editors, diff views
   *
   * Similar to text span but line-based instead of character-based
   * Semantics might differ by editor (inclusive vs exclusive end)
   */
  | { type: 'lines'; start: number; end: number }

  /**
   * AST node reference
   *
   * Used in: code refactoring tools, semantic code editing
   *
   * nodeId = identifier for AST node
   *   Could be: node type + position, UUID, path in AST
   *
   * Enables semantic conflict detection:
   * - "Both users editing same function definition"
   * - "User editing function, AI editing call site" = no conflict
   */
  | { type: 'ast'; nodeId: string }

  /**
   * Geometric bounds (spatial selection)
   *
   * Used in: canvas selection marquee, image crops
   *
   * Not for entity identity (that's pointer.coords) but for
   * selecting PART of an entity geometrically
   *
   * Example: selecting text within a large text block by dragging
   */
  | { type: 'bounds'; x: number; y: number; width: number; height: number }

  /**
   * Apps can extend with custom span types
   *
   * Example: timeline editor might have
   *   { type: 'time-range'; startMs: 1000; endMs: 5000 }
   *
   * Example: 3D viewer might have
   *   { type: 'mesh-selection'; faceIndices: [...] }
   */
  | { type: string; [key: string]: unknown };
