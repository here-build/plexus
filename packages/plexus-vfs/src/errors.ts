/**
 * Errno-style error: a PLAIN `Error` carrying a `.code`. We deliberately do NOT
 * use Plexus's error classes — those schedule an async `console.error` on
 * construction (errors.ts), and a filesystem throws ENOENT as routine control
 * flow (iso-git probes for files that may not exist). `instanceof Error` holds,
 * which is all isomorphic-git checks.
 */
export class FsError extends Error {
  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }

  readonly code: string;
  constructor(code: FsErrno, path: string) {
    super(`${code}: ${path}`);
    this.name = "FsError";
    this.code = code;
  }
}

export enum FsErrno {
  ENOENT = "ENOENT",
  EEXIST = "EEXIST",
  ENOTDIR = "ENOTDIR",
  EISDIR = "EISDIR",
  EPERM = "EPERM",
  EINVAL = "EINVAL",
}
