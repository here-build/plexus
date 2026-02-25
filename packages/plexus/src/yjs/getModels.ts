import * as Y from "yjs";
import type { YPlexusNode } from "../proxy-runtime-types.js";
import * as YJS_GLOBALS from "../YJS_GLOBALS.js";

export const getModelsMap = (doc: Y.Doc) => {
  const outerMap = doc.getMap<Y.Map<YPlexusNode>>(YJS_GLOBALS.types.key);
  return {
    /** The raw outer Y.Map — for UndoManager tracking */
    raw: outerMap,
    getTypeMap(type: string): Y.Map<YPlexusNode> {
      let typeMap = outerMap.get(type);
      if (!typeMap) {
        typeMap = new Y.Map<YPlexusNode>();
        outerMap.set(type, typeMap);
      }
      return typeMap;
    },
    get(uuid: string): YPlexusNode | undefined {
      for (const typeMap of outerMap.values()) {
        const node = typeMap.get(uuid);
        if (node) return node;
      }
      return undefined;
    },
    has(uuid: string): boolean {
      for (const typeMap of outerMap.values()) {
        if (typeMap.has(uuid)) return true;
      }
      return false;
    },
    set(type: string, uuid: string, value: YPlexusNode) {
      this.getTypeMap(type).set(uuid, value);
    },
    delete(uuid: string) {
      for (const typeMap of outerMap.values()) {
        if (typeMap.has(uuid)) {
          typeMap.delete(uuid);
          return;
        }
      }
    },
    *allEntries(): Generator<[string, YPlexusNode]> {
      for (const typeMap of outerMap.values()) {
        yield* typeMap.entries();
      }
    },
  };
};
