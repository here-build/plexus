import * as Y from "yjs";
import type { YPlexusNode } from "../proxy-runtime-types.js";
import * as YJS_GLOBALS from "../YJS_GLOBALS.js";

export const getModelTypesMap = (doc: Y.Doc) => doc.getMap<Y.Map<YPlexusNode>>(YJS_GLOBALS.types.key);
export const ensureModelTypes = (doc: Y.Doc, types: Iterable<string>) => {
  const outerMap = getModelTypesMap(doc);
  for (const type of types) {
    if (!outerMap.has(type)) {
      outerMap.set(type, new Y.Map<YPlexusNode>());
    }
  }
};
// todo - all types should be pre-existent; yet needs checking.
export const getTypeMap = (doc: Y.Doc, type: string) => {
  const outerMap = getModelTypesMap(doc);
  let typeMap = outerMap.get(type);
  if (!typeMap) {
    typeMap = new Y.Map<YPlexusNode>();
    outerMap.set(type, typeMap);
  }
  return typeMap;
};
