import * as Y from "yjs";
import * as YJS_GLOBALS from "../YJS_GLOBALS.js";

export function primeDoc(doc: Y.Doc) {
  // Ensure base maps exist
  doc.getMap(YJS_GLOBALS.models.key);
  doc.getMap(YJS_GLOBALS.metadata.key);
}
