/**
 * isomorphic-git drop-in `fs` adapter over a {@link PlexusFS}.
 *
 * iso-git takes the **promises** path iff the client exposes an *enumerable*
 * `promises` property (it does `'promises' in fs`-style detection and prefers
 * it). So `createFsClient` returns `{ promises: { ... } }` with `promises`
 * enumerable, and implements exactly the eight methods iso-git uses:
 * `readFile`, `writeFile`, `unlink`, `readdir`, `mkdir`, `rmdir`, `stat`,
 * `lstat`.
 *
 * Encoding contract (verified against iso-git 1.38.5):
 *  - `readFile` returns a `Uint8Array` by default; a `{ encoding: 'utf8' }`
 *    option (or the bare string `'utf8'`) makes it return a `string`. iso-git
 *    reads `.git/config`, refs, etc. as utf8 and object files as raw bytes.
 *  - `writeFile` accepts `Uint8Array | string` and stores it faithfully (the
 *    latin1 seam preserves binary git objects exactly).
 *  - Errors are PLAIN `Error`s carrying `.code` ∈ {ENOENT,EEXIST,ENOTDIR,EISDIR}.
 *
 * Symlinks: this string-only VFS has no symlink concept, but iso-git's `bindFs`
 * binds `readlink`/`symlink` UNCONDITIONALLY (it does `fs.readlink.bind(fs)` with
 * no presence guard — the "optional" contract is only that it never *calls* them
 * unless it meets a symlink mode in the tree, which it won't here). So the
 * methods must EXIST as functions; ours throw a faithful errno when actually
 * invoked. Omitting them crashes `bindFs` with "Cannot read properties of
 * undefined (reading 'bind')".
 */
import { FsError, type PlexusFS, type Stats } from "./entities.js";

type EncodingOpt = "utf8" | { encoding?: string } | undefined;

function wantsUtf8(opts: EncodingOpt): boolean {
  if (opts === "utf8") return true;
  if (typeof opts === "object") return opts.encoding === "utf8";
  return false;
}

export interface FsClient {
  promises: {
    readFile(path: string, opts?: EncodingOpt): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string, opts?: unknown): Promise<void>;
    unlink(path: string, opts?: unknown): Promise<void>;
    readdir(path: string, opts?: unknown): Promise<string[]>;
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string, opts?: unknown): Promise<void>;
    stat(path: string, opts?: unknown): Promise<Stats>;
    lstat(path: string, opts?: unknown): Promise<Stats>;
    /** No symlink support — present only so iso-git's `bindFs` can bind it. */
    readlink(path: string, opts?: unknown): Promise<string>;
    /** No symlink support — present only so iso-git's `bindFs` can bind it. */
    symlink(target: string, path: string, opts?: unknown): Promise<void>;
  };
}

/** Build an isomorphic-git-compatible `fs` from a {@link PlexusFS}. */
export function createFsClient(fs: PlexusFS): FsClient {
  const promises: FsClient["promises"] = {
    async readFile(path, opts) {
      const bytes = fs.readFile(path);
      return wantsUtf8(opts) ? new TextDecoder().decode(bytes) : bytes;
    },
    async writeFile(path, data) {
      fs.writeFile(path, data);
    },
    async unlink(path) {
      fs.unlink(path);
    },
    async readdir(path) {
      return fs.readdir(path);
    },
    async mkdir(path, opts) {
      fs.mkdir(path, opts);
    },
    async rmdir(path) {
      fs.rmdir(path);
    },
    async stat(path) {
      return fs.stat(path);
    },
    async lstat(path) {
      return fs.lstat(path);
    },
    // Symlinks unsupported: EINVAL is what a real fs returns for readlink on a
    // non-symlink. iso-git won't reach these unless a symlink mode appears in
    // the tree (it won't, since `symlink` can't create one here).
    async readlink(path) {
      throw new FsError("EINVAL", path);
    },
    async symlink(_target, path) {
      throw new FsError("EPERM", path);
    },
  };

  // `promises` MUST be enumerable — that's iso-git's signal to use the
  // promise-based fs path. A class getter / non-enumerable prop would route it
  // down the callback path it no longer ships.
  return { promises };
}
