/**
 * Presence-shaped awareness for a Flow.
 *
 * Cursor is `{ canvas, x, y }` in the flow's content space, not a viewport
 * point. Selection is `{ canvas, nodes }`. Name is document-scoped.
 */

import { FieldAwareness, PlexusAwareness } from "@here.build/plexus";
import type { Flow, FlowNode } from "@here.build/plexus-xyflow-models";

export const PRESENCE_CURSOR_FIELD = "presence:cursor";
export const PRESENCE_NAME_FIELD = "presence:name";
export const PRESENCE_SELECTION_FIELD = "presence:selection";

export type PresenceAwarenessShape = {
  [PRESENCE_CURSOR_FIELD]: {
    canvas: Flow;
    x: number;
    y: number;
  };
  [PRESENCE_NAME_FIELD]: string;
  [PRESENCE_SELECTION_FIELD]: {
    canvas: Flow;
    nodes: readonly FlowNode[];
  };
};

function hash32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick(hash: number, shift: number, min: number, max: number): number {
  return min + ((hash >>> shift) % (max - min + 1));
}

export class XyflowAwareness extends PlexusAwareness<PresenceAwarenessShape> {
  static readonly GLOBAL_STYLES = `:root{
--presence-hue:0;
--presence-chroma:0.15;
--presence-L-fill:0.37;
--presence-L-ink:0.96;
--presence-L-ink-secondary:0.72;
--presence-ink-chroma:0.02;
--presence-soft-alpha:0.2;
}`;

  static #stylesInstalled = false;

  static installStyles(): void {
    if (XyflowAwareness.#stylesInstalled) return;
    if (typeof document === "undefined") return;
    XyflowAwareness.#stylesInstalled = true;

    if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(this.GLOBAL_STYLES);
      document.adoptedStyleSheets = [sheet, ...document.adoptedStyleSheets];
      return;
    }

    const style = document.createElement("style");
    style.dataset.plexusPresence = "tokens";
    style.textContent = this.GLOBAL_STYLES;
    document.head.prepend(style);
  }

  constructor(...args: ConstructorParameters<typeof PlexusAwareness>) {
    super(...args);
    (this.constructor as typeof XyflowAwareness).installStyles();
  }

  readonly cursor = new FieldAwareness(this, PRESENCE_CURSOR_FIELD);
  readonly selection = new FieldAwareness(this, PRESENCE_SELECTION_FIELD);
  readonly name = new FieldAwareness(this, PRESENCE_NAME_FIELD);

  readonly DEFAULT_PRESENCE_HUE_COUNT = 7;
  readonly DEFAULT_PRESENCE_HUES: readonly number[] = Array.from(
    { length: this.DEFAULT_PRESENCE_HUE_COUNT },
    (_, i) => Math.round((i * 360) / this.DEFAULT_PRESENCE_HUE_COUNT),
  );

  #hueFor = new Map<number, number>();
  #avatars = new Map<number, string>();

  private hueForSeed(seed: string) {
    return this.DEFAULT_PRESENCE_HUES[hash32(seed) % this.DEFAULT_PRESENCE_HUE_COUNT]!;
  }

  hueFor(clientId: number) {
    let hue = this.#hueFor.get(clientId);
    if (hue === undefined) {
      hue = this.hueForSeed(this.getClientIdentity(clientId).key);
      this.#hueFor.set(clientId, hue);
    }
    return hue;
  }

  getClientIdentity(clientId: number): { key: string; displayName?: string } {
    const name = this.name.getOther(clientId);
    return typeof name === "string" && name.length > 0
      ? { key: String(clientId), displayName: name }
      : { key: String(clientId) };
  }

  protected fillForHue(hue: number) {
    return `oklch(var(--presence-L-fill) var(--presence-chroma) ${hue})`;
  }

  fillFor(clientId: number) {
    return this.fillForHue(this.hueFor(clientId));
  }

  protected getAvatarForSeed(seed: string): string {
    const h = hash32(seed);
    const hue = this.hueForSeed(seed);
    const bar = pick(h, 23, 4, 9);
    return `<svg viewBox="0 0 36 36" width="20" height="20" role="img" aria-hidden="true">
    <rect width="36" height="36" rx="18" style="fill:${this.fillForHue(hue)};opacity:0.2"/>
    <circle cx="${pick(h, 3, 10, 26)}" cy="${pick(h, 8, 10, 26)}" r="${pick(h, 13, 9, 15)}" style="fill:${this.fillForHue(hue)}"/>
    <rect x="0" y="${26 - bar}" width="36" height="${bar}"
    transform="rotate(${pick(h, 17, 0, 359)} 18 18)" style="opacity:0.55"/>
    </svg>`;
  }

  getAvatar(clientId: number): string {
    let svg = this.#avatars.get(clientId);
    if (svg === undefined) {
      svg = this.getAvatarForSeed(this.getClientIdentity(clientId).key);
      this.#avatars.set(clientId, svg);
    }
    return svg;
  }

  setCursor(canvas: Flow, pos: { x: number; y: number } | null): void {
    if (pos === null) this.cursor.clear();
    else this.cursor.set({ canvas, x: pos.x, y: pos.y });
  }

  setSelection(canvas: Flow, nodes: readonly FlowNode[] | null): void {
    if (nodes && nodes.length > 0) this.selection.set({ canvas, nodes });
    else this.selection.clear();
  }

  setName(name: string | null): void {
    const next = name?.trim() ?? "";
    if (next) this.name.set(next);
    else this.name.clear();
  }
}
