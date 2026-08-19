/**
 * Shared presence shape for editor bindings (CodeMirror / Lexical).
 *
 * Fields ride `PlexusAwareness` multi-channel protocol. `liminal` is reserved
 * by Plexus core for peer-preview broadcast — do not set it from bindings.
 */

/** Local user identity shown on remote carets. */
export type EditorUser = {
  name?: string;
  /** CSS color for caret / selection highlight. */
  color?: string;
};

/** Selection in code-unit offsets of `toText(doc)` (UTF-16, same as JS strings). */
export type SelectionPresence = {
  anchor: number;
  head: number;
};

/**
 * Awareness fields published by text bindings.
 * Peers assemble via `awareness.getPeer(id)`.
 */
export type TextPresence = {
  selection?: SelectionPresence | null;
  user?: EditorUser;
  /** Reserved — Plexus sets/clears this for liminal peer preview. */
  liminal?: unknown;
};

/** Default palette for peers without an explicit color. */
const DEFAULT_COLORS = [
  "#30bced",
  "#6eeb83",
  "#ffbc42",
  "#ec368d",
  "#a06cd5",
  "#ff6b6b",
  "#4ecdc4",
  "#ffe66d",
];

export function colorForClientId(clientId: number): string {
  return DEFAULT_COLORS[Math.abs(clientId) % DEFAULT_COLORS.length];
}

export function lightColor(color: string): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    return color.length === 7 ? `${color}33` : `${color}3`;
  }
  return color;
}
