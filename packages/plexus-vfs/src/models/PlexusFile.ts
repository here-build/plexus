import { PlexusModel, syncing } from "@here.build/plexus";
import { entityPath } from "../utils/entityPath.js";

/**
 * Normalize incoming bytes to THIS realm's `Uint8Array` before they reach the
 * CRDT. A `Uint8Array` from another realm (jsdom's `TextEncoder` under vitest,
 * a subclass, a cross-frame buffer) has a different constructor identity, which
 * yjs's value encoding dispatches on — storing it corrupts/rejects the write.
 * The constructor check makes this free in production (single realm, no copy).
 */
export function normalizeBytes(u: Uint8Array): Uint8Array {
  return u.constructor === Uint8Array ? u : new Uint8Array(u);
}

/**
 * A file. Content is the raw byte sequence, stored directly as a `Uint8Array`
 * `@syncing` val (CRDT-backed via plexus-core's typed-array proxy). The
 * ergonomic accessors (`bytes`/`text`) project onto it; `content` itself is the
 * live, per-index-reactive proxy.
 */
@syncing("@here.build/plexus-vfs:File")
export class PlexusFile extends PlexusModel {
  /** Raw file bytes. A `Uint8Array` @syncing val — in-place mutations sync per index. */
  @syncing accessor content: Uint8Array = new Uint8Array(0);
  /** Bumped on every content write (ms since epoch). */
  @syncing accessor mtimeMs: number = 0;

  /** Name = this file's key in its parent dir's `entries` record. */
  get name(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  /** Full POSIX path from the FS root, derived by walking parents. */
  get path(): string {
    return entityPath(this);
  }

  get bytes(): Uint8Array {
    // `content` is the live CRDT typed-array proxy (array-like/iterable, not a
    // genuine ArrayBufferView). Materialize a real Uint8Array so structured
    // consumers (TextDecoder, R2, Y.applyUpdate) accept it.
    return Uint8Array.from(this.content);
  }
  set bytes(b: Uint8Array) {
    this.content = normalizeBytes(b);
    this.mtimeMs = Date.now();
  }

  /** The content decoded as UTF-8 text. */
  get text(): string {
    return new TextDecoder().decode(this.bytes);
  }
  set text(t: string) {
    this.bytes = new TextEncoder().encode(t);
  }

  /** Byte length of the content. */
  get size(): number {
    return this.content.length;
  }
}
