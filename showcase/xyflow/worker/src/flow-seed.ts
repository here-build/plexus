import { Plexus } from "@here.build/plexus";
import { defaultFlow } from "@here.build/plexus-xyflow-models";
import * as Y from "yjs";

/**
 * First-writer bytes for an empty room. The Worker plants this once;
 * browsers `connect` after sync. Same seed applied twice would be two trees.
 */
export function encodeFlowSeed(guid: string): Uint8Array {
  const plexus = Plexus.bootstrap(defaultFlow(), guid, undefined, { undo: "stub" });
  const bytes = Y.encodeStateAsUpdate(plexus.doc);
  plexus.destroy();
  return bytes;
}
