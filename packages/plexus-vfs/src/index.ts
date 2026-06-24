/**
 * @here.build/plexus-vfs — a Plexus-backed virtual filesystem.
 *
 * The entities ({@link PlexusFile}, {@link PlexusDir}, {@link PlexusFS}) are a
 * CRDT-synced file tree. The isomorphic-git drop-in adapter lives at the
 * `./fs-client` subpath (`createFsClient`).
 *
 * STRING-ONLY interim: content is stored as a latin1 byte-string through the
 * single {@link binToBytes}/{@link bytesToBin} seam, so arbitrary binary
 * round-trips faithfully.
 */
export { PlexusFile, PlexusDir, PlexusFS, FsError, type FsErrno, type Stats } from "./entities.js";
export { binToBytes, bytesToBin, uint32FromUUID } from "./bin.js";
export { splitPath, joinPath, basename, dirname } from "./path.js";
