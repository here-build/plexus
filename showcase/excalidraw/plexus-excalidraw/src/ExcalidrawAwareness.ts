/**
 * Presence-shaped awareness for an Excalidraw Scene.
 *
 * Cursor is `{ canvas, x, y }` in that canvas's own content space, not a
 * viewport point. Selection is `{ canvas, elements }`. Name is document-scoped.
 * Models come back as the tree instances.
 *
 * Field names are append-only on the wire once first used — hosts extend the
 * shape; they do not rename these.
 *
 * Hue and avatar seed from `getClientIdentity`. Identity is derived
 * independently on every peer, so the hash must be deterministic — anything
 * host-specific or randomized paints one person in different colours for
 * different people.
 */

import { FieldAwareness, PlexusAwareness } from "@here.build/plexus";
import type { ExcalidrawAnyElement, Scene } from "@here.build/plexus-excalidraw-models";

export const PRESENCE_CURSOR_FIELD = "presence:cursor";
export const PRESENCE_NAME_FIELD = "presence:name";
export const PRESENCE_SELECTION_FIELD = "presence:selection";

export type PresenceAwarenessShape = {
  [PRESENCE_CURSOR_FIELD]: {
    canvas: Scene;
    /** In `canvas`'s own content space. */
    x: number;
    y: number;
  };
  [PRESENCE_NAME_FIELD]: string;
  [PRESENCE_SELECTION_FIELD]: {
    canvas: Scene;
    elements: readonly ExcalidrawAnyElement[];
  };
};

/** FNV-1a over a string. */
function hash32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer in `[min, max]` from one hash, using bits at `shift`. */
function pick(hash: number, shift: number, min: number, max: number): number {
  return min + ((hash >>> shift) % (max - min + 1));
}

export class ExcalidrawAwareness extends PlexusAwareness<PresenceAwarenessShape> {
  /**
   * Default `--presence-*` tokens. Not a `.css` import: that would force every
   * consumer's bundler to handle CSS. Installed first so a host override at
   * equal specificity wins. `fillFor` and friends resolve to an invalid color
   * if these never land.
   */
  static readonly GLOBAL_STYLES = `:root{
--presence-hue:0;
--presence-chroma:0.15;
--presence-L-fill:0.37;
--presence-L-ink:0.96;
--presence-L-ink-secondary:0.72;
--presence-ink-chroma:0.02;
--presence-soft-alpha:0.2;
--presence-cursor-stem:14px;
--presence-cursor-pad-x:8px;
--presence-cursor-pad-y:4px;
--presence-cursor-gap:4px;
--presence-cursor-label-size:11px;
--presence-cursor-avatar-size:20px;
--presence-cursor-radius-pill:999px;
}`;

  static #stylesInstalled = false;

  /**
   * Idempotent. No-op without a DOM, so constructing awareness in a Worker
   * or on the server stays side-effect free.
   */
  static installStyles(): void {
    if (ExcalidrawAwareness.#stylesInstalled) return;
    if (typeof document === "undefined") return;
    ExcalidrawAwareness.#stylesInstalled = true;

    if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in document) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(this.GLOBAL_STYLES);
      // Prepend: adopted sheets lose to author stylesheets at equal specificity,
      // and earlier adopted sheets lose to later ones. Both favour the host.
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
    (this.constructor as typeof ExcalidrawAwareness).installStyles();
  }

  /** Live `{ canvas, x, y }`. `canvas` is the tree instance. */
  readonly cursor = new FieldAwareness(this, PRESENCE_CURSOR_FIELD);
  /** Live `{ canvas, elements }`. `elements` are the tree instances. */
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

  getClientIdentity(clientId: number): {
    /**
     * Stable derivation key. Hue and avatar are seeded from this, so two sessions
     * that share a key look like one person.
     */
    key: string;
    displayName?: string;
  } {
    const name = this.name.getOther(clientId);

    return typeof name === "string" && name.length > 0
      ? { key: String(clientId), displayName: name }
      : { key: String(clientId) };
  }

  protected fillForHue(hue: number) {
    return `oklch(var(--presence-L-fill) var(--presence-chroma) ${hue})`;
  }

  fillFor(clientId: number) {
    return `oklch(var(--presence-L-fill) var(--presence-chroma) ${this.getClientIdentity(clientId).key})`;
  }

  protected softFillForHue(hue: number) {
    return `oklch(var(--presence-L-fill) var(--presence-chroma) ${hue} / var(--presence-soft-alpha, 0.2))`;
  }

  softFillFor(clientId: number) {
    return `oklch(var(--presence-L-fill) var(--presence-chroma) ${this.getClientIdentity(clientId).key}} / var(--presence-soft-alpha, 0.2))`;
  }

  protected inkForHue(hue: number) {
    return `oklch(var(--presence-L-ink) var(--presence-ink-chroma) ${hue})`;
  }

  inkFor(clientId: number) {
    return `oklch(var(--presence-L-ink) var(--presence-ink-chroma) ${this.getClientIdentity(clientId).key}})`;
  }

  protected getAvatarForSeed(seed: string): string {
    const h = hash32(seed);
    const hue = this.hueForSeed(seed);
    const bar = pick(h, 23, 4, 9);

    return `<svg viewBox="0 0 36 36" width="20" height="20" role="img" aria-hidden="true">
    <rect width="36" height="36" rx="18" style="fill:${this.softFillForHue(hue)}"/>
    <circle cx="${pick(h, 3, 10, 26)}" cy="${pick(h, 8, 10, 26)}" r="${pick(h, 13, 9, 15)}" style="fill:${this.fillForHue(hue)}"/>
    <rect x="0" y="${26 - bar}" width="36" height="${bar}" 
    transform="rotate(${pick(h, 17, 0, 359)} 18 18)" style="fill:${this.inkForHue(hue)};opacity:0.55"/>
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

  setCursor(canvas: Scene, pos: { x: number; y: number } | null): void {
    if (pos === null) {
      this.cursor.clear();
    } else {
      this.cursor.set({ canvas, x: pos.x, y: pos.y });
    }
  }

  setSelection(canvas: Scene, elements: readonly ExcalidrawAnyElement[] | null): void {
    if (elements && elements.length > 0) {
      this.selection.set({ canvas, elements });
    } else {
      this.selection.clear();
    }
  }

  setName(name: string | null): void {
    const next = name?.trim() ?? "";
    if (next) {
      this.name.set(next);
    } else {
      this.name.clear();
    }
  }
}
