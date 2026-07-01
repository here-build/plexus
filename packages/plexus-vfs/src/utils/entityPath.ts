import { PlexusModel } from "@here.build/plexus";

import { PlexusDir } from "../models/PlexusDir.js";
import { PlexusFile } from "../models/PlexusFile.js";

/** Walk an entity's parent chain, collecting names, to build its full POSIX path. */
export function entityPath(entity: PlexusFile | PlexusDir): string {
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
