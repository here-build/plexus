import { PlexusModel, syncing } from "@here.build/plexus";

import { FsErrno, FsError } from "../errors.js";
import { PlexusFile } from "./PlexusFile.js";
import { entityPath } from "../utils/entityPath.js";
import { splitPath } from "../utils/path.js";
import { transact } from "../utils/transact.js";

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
    } else {
      FsError.invariant(next instanceof PlexusDir, FsErrno.ENOTDIR, path);
      dir = next;
    }
  }
  return dir;
}
