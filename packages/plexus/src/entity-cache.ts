import * as Y from "yjs";
import { DefaultedWeakMap } from "./utils";
import type { PlexusModel } from "./PlexusModel";

// Entity cache - stores weak references to PlexusModel instances by document and entity ID
export const documentEntityCaches = new DefaultedWeakMap<Y.Doc, Map<string, WeakRef<PlexusModel>>>(
  () => new Map<string, WeakRef<PlexusModel>>()
);
