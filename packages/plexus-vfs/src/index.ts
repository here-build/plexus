/**
 * @here.build/plexus-vfs — a Plexus-backed virtual filesystem.
 *
 * The entities ({@link PlexusFile}, {@link PlexusDir}, {@link PlexusFS}) are a
 * CRDT-synced file tree. {@link PlexusFS} implements the node `fs.promises` /
 * isomorphic-git drop-in contract directly (via its `.promises` object).
 *
 * File content is stored directly as a `Uint8Array` `@syncing` val (CRDT-backed
 * via plexus-core's typed-array proxy), so arbitrary binary round-trips faithfully.
 */
export { FsError, type FsErrno } from "./errors.js";
export { splitPath, joinPath, basename, dirname } from "./utils/path.js";
export { PlexusDir } from "./models/PlexusDir.js";
export { PlexusFS } from "./models/PlexusFS.js";
export { type Stats } from "./types/index.js";
export { PlexusFile } from "./models/PlexusFile.js";
