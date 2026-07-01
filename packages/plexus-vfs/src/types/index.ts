import { PromiseFsClient } from "isomorphic-git";

export type EncodingOpt = "utf8" | { encoding?: string } | undefined;

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

export interface NarrowedPromiseFsClient extends PromiseFsClient {
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
