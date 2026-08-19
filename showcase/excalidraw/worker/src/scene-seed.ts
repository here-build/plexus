import { Plexus } from "@here.build/plexus";
import { defaultScene } from "@here.build/plexus-excalidraw-models";
import * as Y from "yjs";

/**
 * First-writer bytes for an empty room. The Worker plants this once;
 * browsers `connect` after sync. Same seed applied twice would be two trees.
 */
export function encodeSceneSeed(guid: string): Uint8Array {
  const doc = new Y.Doc({ guid });
  Plexus.bootstrap(defaultScene(), guid, doc, { undo: "stub" });
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
