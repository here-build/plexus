import { syncing } from "@here.build/plexus";

import { PlexusDir } from "./PlexusDir.js";
import { FsErrno, FsError } from "../errors.js";
import { normalizeBytes, PlexusFile } from "./PlexusFile.js";
import { EncodingOpt, NarrowedPromiseFsClient, Stats } from "../types/index.js";
import { basename, joinPath, splitPath } from "../utils/path.js";
import { transact } from "../utils/transact.js";

/**
 * The filesystem root: a `PlexusDir` that is both the tree root and the
 * ergonomic, path-addressed facade. It can be a Plexus root on its own
 * (`Plexus.bootstrap(new PlexusFS(), ...)`) or nested as a `@syncing.child`
 * field on a larger model (e.g. `class Project { @syncing.child accessor fs: PlexusFS }`).
 *
 * The methods here are path-based conveniences; the `.promises` object on this
 * class is the node `fs.promises` / isomorphic-git drop-in surface, mapping that
 * contract onto them.
 */
@syncing("@here.build/plexus-vfs:FS")
export class PlexusFS extends PlexusDir implements NarrowedPromiseFsClient {
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

  public readonly promises = {
    readFile: async (path: string, opts?: EncodingOpt) => {
      const bytes = this.readFile(path);
      return wantsUtf8(opts) ? new TextDecoder().decode(bytes) : bytes;
    },
    writeFile: async (path: string, data: Uint8Array | string) => {
      this.writeFile(path, data);
    },
    unlink: async (path: string) => {
      this.unlink(path);
    },
    readdir: async (path: string) => {
      return this.readdir(path);
    },
    mkdir: async (path: string, opts?: { recursive?: boolean }) => {
      this.mkdir(path, opts);
    },
    rmdir: async (path: string) => {
      this.rmdir(path);
    },
    stat: async (path: string) => {
      return this.stat(path);
    },
    lstat: async (path: string) => {
      return this.lstat(path);
    },
    // Symlinks unsupported: EINVAL is what a real fs returns for readlink on a
    // non-symlink. iso-git won't reach these unless a symlink mode appears in
    // the tree (it won't, since `symlink` can't create one here).
    async readlink(path) {
      throw new FsError(FsErrno.EINVAL, path);
    },
    async symlink(_target, path) {
      throw new FsError(FsErrno.EPERM, path);
    },
  };

  /** Read a file's raw bytes. ENOENT if absent, EISDIR if it's a directory. */
  readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    FsError.invariant(node !== null, FsErrno.ENOENT, path);
    FsError.invariant(node instanceof PlexusFile, FsErrno.EISDIR, path);
    return node.bytes;
  }

  /** Write a file (creating parent dirs), storing `data` faithfully. */
  writeFile(path: string, data: Uint8Array | string): void {
    const segs = splitPath(path);
    const name = segs.at(-1);
    FsError.invariant(name !== undefined, FsErrno.EISDIR, path);
    transact(this, () => {
      const dir = this.ensureDir(joinPath(segs.slice(0, -1)));
      const existing = dir.entries[name];
      FsError.invariant(!(existing instanceof PlexusDir), FsErrno.EISDIR, path);
      // normalizeBytes: jsdom's TextEncoder (and any foreign-realm caller) hands
      // back a Uint8Array with a foreign constructor identity — normalize before
      // it reaches the CRDT (see PlexusFile.normalizeBytes).
      const bytes = normalizeBytes(typeof data === "string" ? new TextEncoder().encode(data) : data);
      if (existing instanceof PlexusFile) {
        existing.bytes = bytes;
      } else {
        dir.entries[name] = new PlexusFile({ content: bytes, mtimeMs: Date.now() });
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
    FsError.invariant(node instanceof PlexusDir, FsErrno.ENOTDIR, path);
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
    FsError.invariant(name !== undefined, FsErrno.EEXIST, path);
    transact(this, () => {
      const parent = this.resolve(joinPath(segs.slice(0, -1)));
      FsError.invariant(parent instanceof PlexusDir, FsErrno.ENOENT, path);
      FsError.invariant(parent.entries[name] === undefined, FsErrno.EEXIST, path);
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
    FsError.invariant(dir !== null, FsErrno.ENOENT, path);
    const name = basename(path);
    const node = dir.entries[name];
    FsError.invariant(node !== undefined, FsErrno.ENOENT, path);
    if (kind === "file") {
      FsError.invariant(node instanceof PlexusFile, FsErrno.EISDIR, path);
    }
    if (kind === "dir") {
      FsError.invariant(node instanceof PlexusDir, FsErrno.ENOTDIR, path);
    }
    delete dir.entries[name];
  }

  /** stat — for this VFS lstat is identical (no symlinks). */
  stat(path: string): Stats {
    const node = this.lookup(path);
    FsError.invariant(node !== null, FsErrno.ENOENT, path);
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

  /** lstat — same as stat here (symlinks are out of scope). */
  lstat(path: string): Stats {
    return this.stat(path);
  }
}

/**
 * Stable uint32 from a PlexusUUID string (FNV-1a). iso-git folds `stat.ino` into
 * its index; it only needs to be stable per entity across reads, not globally
 * unique. FNV-1a over the UUID chars gives exactly that.
 */
function uint32FromUUID(uuid: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < uuid.length; i++) {
    // charCodeAt (UTF-16 code units) is correct here: PlexusUUIDs are ASCII, so
    // there are no surrogate pairs and the per-unit read is surrogate-safe.
    // eslint-disable-next-line unicorn/prefer-code-point
    h ^= uuid.charCodeAt(i);
    // h * 16777619 (the FNV prime) via shifts, kept in uint32 by the final >>> 0
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function wantsUtf8(opts: EncodingOpt): boolean {
  if (opts === "utf8") return true;
  if (typeof opts === "object") return opts.encoding === "utf8";
  return false;
}
