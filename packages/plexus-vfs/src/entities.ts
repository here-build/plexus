import { docPlexus, PlexusModel, syncing } from "@here.build/plexus";

import { binToBytes, bytesToBin, uint32FromUUID } from "./bin.js";
import { basename, joinPath, splitPath } from "./path.js";

/**
 * Errno-style error: a PLAIN `Error` carrying a `.code`. We deliberately do NOT
 * use Plexus's error classes — those schedule an async `console.error` on
 * construction (errors.ts), and a filesystem throws ENOENT as routine control
 * flow (iso-git probes for files that may not exist). `instanceof Error` holds,
 * which is all isomorphic-git checks.
 */
export class FsError extends Error {
  readonly code: string;
  constructor(code: string, path: string) {
    super(`${code}: ${path}`);
    this.name = "FsError";
    this.code = code;
  }
}

export type FsErrno = "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR";

/** Run `fn` inside the owning doc's transaction (atomic multi-step ops). */
function transact<T>(node: PlexusModel, fn: () => T): T {
  const doc = node.__doc__;
  const plexus = doc ? docPlexus.get(doc) : undefined;
  return plexus ? plexus.transact(fn) : fn();
}

/**
 * A file. Content is the raw byte sequence held as a latin1 string (1 char = 1
 * byte) — the single storage seam (see ./bin). All the ergonomic accessors
 * (`bytes`/`text`) project through that seam.
 */
@syncing("@here.build/plexus-vfs:File")
export class PlexusFile extends PlexusModel {
  /** latin1 byte-string. The one field that changes when real Uint8Array storage lands. */
  @syncing accessor content: string = "";
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

  /** The content as raw bytes. */
  get bytes(): Uint8Array {
    return binToBytes(this.content);
  }
  set bytes(b: Uint8Array) {
    this.content = bytesToBin(b);
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

/**
 * A directory: a record of named children (files or subdirs). Children are
 * Plexus-owned (`@syncing.child.record`), so each child's `parentFieldKey` is
 * its name and ownership is exclusive (moving a child re-keys it automatically).
 */
@syncing("@here.build/plexus-vfs:Dir")
export class PlexusDir extends PlexusModel {
  @syncing.child.record accessor entries: Record<string, PlexusFile | PlexusDir> = {};

  /** Name = this dir's key in its parent dir's `entries` record. */
  get name(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  /** Full POSIX path from the FS root. */
  get path(): string {
    return entityPath(this);
  }

  /**
   * Walk a relative path over `entries`, returning the entity or `null` if any
   * segment is missing or a non-final segment is a file (not traversable).
   */
  resolve(path: string): PlexusFile | PlexusDir | null {
    return walkResolve(this, splitPath(path));
  }

  /**
   * Ensure a directory exists at `path` (relative to this dir), creating
   * intermediate dirs (mkdir -p). Throws ENOTDIR if a path segment is a file.
   * Returns the (existing or created) directory.
   */
  ensureDir(path: string): PlexusDir {
    return transact(this, () => walkEnsureDir(this, splitPath(path), path));
  }
}

/** Walk segments over a dir tree; null on a missing segment or descent-into-file. */
function walkResolve(start: PlexusDir, segments: readonly string[]): PlexusFile | PlexusDir | null {
  let dir: PlexusDir = start;
  const lastIndex = segments.length - 1;
  for (const [i, seg] of segments.entries()) {
    const next = dir.entries[seg];
    if (next === undefined) return null;
    if (next instanceof PlexusFile) {
      // A file is only a valid result as the LAST segment; can't descend into it.
      return i === lastIndex ? next : null;
    }
    dir = next;
  }
  return dir;
}

/** mkdir -p walk: create missing dirs, throw ENOTDIR on a file in the path. */
function walkEnsureDir(start: PlexusDir, segments: readonly string[], path: string): PlexusDir {
  let dir: PlexusDir = start;
  for (const seg of segments) {
    const next: PlexusFile | PlexusDir | undefined = dir.entries[seg];
    if (next === undefined) {
      dir.entries[seg] = new PlexusDir();
      // Re-read through the record so we hold the live (materialized) instance.
      dir = dir.entries[seg] as PlexusDir;
    } else if (next instanceof PlexusFile) {
      throw new FsError("ENOTDIR", path);
    } else {
      dir = next;
    }
  }
  return dir;
}

/**
 * The filesystem root: a `PlexusDir` that is both the tree root and the
 * ergonomic, path-addressed facade. It can be a Plexus root on its own
 * (`Plexus.bootstrap(new PlexusFS(), ...)`) or nested as a `@syncing.child`
 * field on a larger model (e.g. `class Project { @syncing.child accessor fs: PlexusFS }`).
 *
 * The methods here are path-based conveniences; the iso-git adapter
 * (./fs-client) is the canonical surface that maps the node `fs.promises`
 * contract onto them.
 */
@syncing("@here.build/plexus-vfs:FS")
export class PlexusFS extends PlexusDir {
  /** Resolve a path to its entity, or null. */
  private lookup(path: string): PlexusFile | PlexusDir | null {
    return this.resolve(path);
  }

  /** Resolve the parent dir of `path`, or null if the parent chain is missing/a-file. */
  private parentDirOf(path: string): PlexusDir | null {
    const segs = splitPath(path);
    segs.pop();
    const node = this.resolve(segs.join("/"));
    return node instanceof PlexusFile ? null : node;
  }

  /** Read a file's raw bytes. ENOENT if absent, EISDIR if it's a directory. */
  readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    if (node === null) throw new FsError("ENOENT", path);
    if (!(node instanceof PlexusFile)) throw new FsError("EISDIR", path);
    return node.bytes;
  }

  /** Write a file (creating parent dirs), storing `data` faithfully. */
  writeFile(path: string, data: Uint8Array | string): void {
    const segs = splitPath(path);
    const name = segs.at(-1);
    if (name === undefined) throw new FsError("EISDIR", path);
    transact(this, () => {
      const dir = this.ensureDir(joinPath(segs.slice(0, -1)));
      const existing = dir.entries[name];
      if (existing instanceof PlexusDir) throw new FsError("EISDIR", path);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (existing instanceof PlexusFile) {
        existing.bytes = bytes;
      } else {
        dir.entries[name] = new PlexusFile({ content: bytesToBin(bytes), mtimeMs: Date.now() });
      }
    });
  }

  /** Remove a file. ENOENT if absent, EISDIR if it's a directory. */
  unlink(path: string): void {
    this.removeEntry(path, "file");
  }

  /** Directory entry names. ENOENT if absent, ENOTDIR if it's a file. */
  readdir(path: string): string[] {
    const node = this.lookup(path);
    if (node === null) throw new FsError("ENOENT", path);
    if (node instanceof PlexusFile) throw new FsError("ENOTDIR", path);
    return Object.keys(node.entries);
  }

  /** Create a directory. EEXIST if it already exists and `recursive` is false. */
  mkdir(path: string, opts?: { recursive?: boolean }): void {
    if (opts?.recursive) {
      this.ensureDir(path);
      return;
    }
    const segs = splitPath(path);
    const name = segs.at(-1);
    if (name === undefined) throw new FsError("EEXIST", path);
    transact(this, () => {
      const parent = this.resolve(joinPath(segs.slice(0, -1)));
      if (parent === null || parent instanceof PlexusFile) throw new FsError("ENOENT", path);
      if (parent.entries[name] !== undefined) throw new FsError("EEXIST", path);
      parent.entries[name] = new PlexusDir();
    });
  }

  /** Remove a directory. ENOENT if absent, ENOTDIR if it's a file. */
  rmdir(path: string): void {
    this.removeEntry(path, "dir");
  }

  /**
   * Shared remove for unlink/rmdir: locate the entry in its parent dir and
   * delete it, raising the kind-appropriate errno. `kind: "file"` → EISDIR if
   * the target is a directory; `kind: "dir"` → ENOTDIR if it's a file.
   */
  private removeEntry(path: string, kind: "file" | "dir"): void {
    const dir = this.parentDirOf(path);
    const name = basename(path);
    const node = dir === null ? undefined : dir.entries[name];
    if (node === undefined || dir === null) throw new FsError("ENOENT", path);
    if (kind === "file" && node instanceof PlexusDir) throw new FsError("EISDIR", path);
    if (kind === "dir" && node instanceof PlexusFile) throw new FsError("ENOTDIR", path);
    delete dir.entries[name];
  }

  /** stat — for this string-only VFS lstat is identical (no symlinks). */
  stat(path: string): Stats {
    const node = this.lookup(path);
    if (node === null) throw new FsError("ENOENT", path);
    return makeStats(node);
  }

  /** lstat — same as stat here (symlinks are out of scope). */
  lstat(path: string): Stats {
    return this.stat(path);
  }
}

/**
 * The Stats shape isomorphic-git folds into its index. `mode >> 12` is how
 * iso-git reads the entry type, so the octal type bits are load-bearing; `ino`
 * must be stable per entity across reads (we derive it from the PlexusUUID).
 */
export interface Stats {
  mode: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  uid: number;
  gid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function makeStats(node: PlexusFile | PlexusDir): Stats {
  const isDir = node instanceof PlexusDir;
  const mtimeMs = node instanceof PlexusFile ? node.mtimeMs : 0;
  return {
    mode: isDir ? 0o04_0000 : 0o10_0644,
    ino: uint32FromUUID(node.uuid),
    size: node instanceof PlexusFile ? node.size : 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    dev: 0,
    uid: 0,
    gid: 0,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  };
}

/** Walk an entity's parent chain, collecting names, to build its full POSIX path. */
function entityPath(entity: PlexusFile | PlexusDir): string {
  const segments: string[] = [];
  let node: PlexusModel | null = entity;
  // Climb while we're inside the VFS tree (a Dir/File child of another Dir).
  while (node instanceof PlexusFile || node instanceof PlexusDir) {
    // Record-keyed children always carry a string key; null = root / non-VFS parent.
    const key = node.parentFieldKey as string | null;
    if (key === null) break;
    segments.unshift(key);
    node = node.parent as PlexusModel | null;
  }
  return segments.join("/");
}
