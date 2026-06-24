/**
 * @here.build/plexus-vfs — a Plexus-backed virtual filesystem.
 *
 * The entities ({@link PlexusFile}, {@link PlexusDir}, {@link PlexusFS}) are a
 * CRDT-synced file tree. The isomorphic-git drop-in adapter lives at the
 * `./fs-client` subpath (`createFsClient`).
 *
 * File content is stored directly as a `Uint8Array` `@syncing` val (CRDT-backed
 * via plexus-core's typed-array proxy), so arbitrary binary round-trips faithfully.
 */
export { PlexusFile, PlexusDir, PlexusFS, FsError, type FsErrno, type Stats } from "./entities.js";
export { splitPath, joinPath, basename, dirname } from "./path.js";
