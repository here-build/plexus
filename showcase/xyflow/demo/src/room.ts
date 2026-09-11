/** Default guid when the URL has no `?room=` and we cannot rewrite it (tests, SSR). */
export const DEFAULT_ROOM = "plexus-xyflow";

export type ResolvedRoom = {
  room: string;
  search: string;
  assigned: boolean;
};

/**
 * Shareable room id. Missing `?room=` is assigned so the URL is the invite —
 * two tabs on the same href share a document; a bare `/` is a new one.
 */
export function resolveRoom(href: string, mint: () => string): ResolvedRoom {
  const url = new URL(href, "http://plexus.local");
  const existing = url.searchParams.get("room")?.trim();
  if (existing) {
    return { room: existing, search: url.search, assigned: false };
  }
  const room = mint();
  url.searchParams.set("room", room);
  return { room, search: url.search, assigned: true };
}

export function mintRoom(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 6);
  return `flow-${suffix}`;
}

export function bindRoom(locationLike: { href: string }, replace: (url: string) => void): string {
  const resolved = resolveRoom(locationLike.href, mintRoom);
  if (resolved.assigned) {
    const next = new URL(locationLike.href);
    next.search = resolved.search;
    replace(next.pathname + next.search + next.hash);
  }
  return resolved.room;
}
