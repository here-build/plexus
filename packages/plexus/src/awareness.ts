// Semantic awareness state for collaborative editing
import * as awarenessProtocol from "y-protocols/awareness";

export interface PlexusUserState {
  // User identification
  userId: string;
  userInfo: {
    name?: string;
    avatar?: string;
    color?: string;
  };

  // Current context within document
  currentContext?: string[]; // Array of entity IDs from root to current

  // Pointer/cursor position
  pointerPosition?: {
    entityId?: string;
    localPosition?: { x: number; y: number };
  };

  // Selection state
  selection?: string[]; // Array of selected entity IDs

  // Viewport information
  viewport?: {
    bounds: { x: number; y: number; width: number; height: number };
    zoom?: number;
    focusedEntity?: string;
  };

  // Collaboration state
  following?: {
    userId: string;
    mode: "viewport" | "cursor" | "selection";
  };

  // Activity state
  isFocused: boolean;

  // Edit state
  editMode?: "viewing" | "typing" | "dragging" | "selecting" | "resizing";
  currentTool?: string;
  toolState?: Record<string, any>;
}

export class PlexusAwareness {
  private localState: PlexusUserState = {
    userId: "",
    userInfo: {},
    isFocused: true
  };

  constructor(private readonly awareness: awarenessProtocol.Awareness) {}

  // Update local user state
  updateUserInfo(userInfo: PlexusUserState["userInfo"]) {
    this.localState.userInfo = { ...this.localState.userInfo, ...userInfo };
    this.broadcastState();
  }

  updateContext(context: string[]) {
    this.localState.currentContext = context;
    this.broadcastState();
  }

  updatePointer(entityId?: string, localPosition?: { x: number; y: number }) {
    this.localState.pointerPosition = entityId ? { entityId, localPosition } : undefined;
    this.broadcastState();
  }

  updateSelection(selection: string[]) {
    this.localState.selection = selection;
    this.broadcastState();
  }

  updateViewport(viewport: PlexusUserState["viewport"]) {
    this.localState.viewport = viewport;
    this.broadcastState();
  }

  updateFollowing(following: PlexusUserState["following"]) {
    this.localState.following = following;
    this.broadcastState();
  }

  updateFocus(isFocused: boolean) {
    this.localState.isFocused = isFocused;
    this.broadcastState();
  }

  updateEditMode(editMode: PlexusUserState["editMode"], tool?: string, toolState?: Record<string, any>) {
    this.localState.editMode = editMode;
    this.localState.currentTool = tool;
    this.localState.toolState = toolState;
    this.broadcastState();
  }

  // Get other users' states
  getUsers(): Map<number, PlexusUserState> {
    const states = new Map<number, PlexusUserState>();
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId !== this.awareness.clientID && state.plexus) {
        states.set(clientId, state.plexus as PlexusUserState);
      }
    });
    return states;
  }

  // Subscribe to awareness changes
  onChange(callback: (users: Map<number, PlexusUserState>) => void) {
    const handler = () => callback(this.getUsers());
    this.awareness.on("change", handler);
    return () => this.awareness.off("change", handler);
  }

  private broadcastState() {
    this.awareness.setLocalStateField("plexus", this.localState);
  }
}
