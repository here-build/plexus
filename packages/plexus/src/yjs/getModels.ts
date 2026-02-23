import type * as Y from "yjs";
import { YPlexusNode } from "../proxy-runtime-types.js";
import * as YJS_GLOBALS from "../YJS_GLOBALS.js";

export const getModelsMap = (doc: Y.Doc) => {
  const map = doc.getMap<YPlexusNode>(YJS_GLOBALS.models.key);
  return {
    model: map,
    get(uuid: string): YPlexusNode | undefined {
      return map.get(uuid);
    },
    has(uuid: string): boolean {
      return map.has(uuid);
    },
    set(uuid: string, value: YPlexusNode) {
      map.set(uuid, value);
    },
    delete(uuid: string) {
      map.delete(uuid);
    },
    entries() {
      return map.entries();
    },
  };
};
