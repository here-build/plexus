import * as Y from "yjs";
import { AllowedYValue, ModelPattern } from "../proxy-runtime-types";
import { curryMaybeReference, maybeReference } from "../utils";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking";
import { deref } from "../deref";
import { YJS_GLOBALS } from "../YJS_GLOBALS";

export type MaterializedRecordProxyInitTarget = {
  doc: Y.Doc;
  projectId: string;
  type: string;
  mapProxy: {};
  map: Y.Map<AllowedYValue>;
  boundMaybeReference: ReturnType<typeof curryMaybeReference>;
}

export const materializedRecordProxyInit: ProxyHandler<MaterializedRecordProxyInitTarget> = {
  get({map, mapProxy, projectId, doc}, elementKey) {
    switch (elementKey) {
      case "clear":
        return () => {
          trackModification(mapProxy, ACCESS_ALL_SYMBOL);
          trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
          map.clear();
        };
      case "assign":
        return (newEntries: Record<string, ModelPattern> | Iterable<[string, ModelPattern]>) => {
          trackModification(mapProxy, ACCESS_ALL_SYMBOL);
          trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
          // Clear existing contents
          map.clear();
          // Add new entries
          if (Symbol.iterator in Object(newEntries)) {
            // Iterable of [key, value] pairs
            for (const [k, v] of newEntries as Iterable<[string, ModelPattern]>) {
              map.set(k, maybeReference(v, projectId, doc));
            }
          } else {
            // Record object
            for (const [k, v] of Object.entries(newEntries as Record<string, ModelPattern>)) {
              map.set(k, maybeReference(v, projectId, doc));
            }
          }
        };
    }

    // Well-known Symbol support for record/map
    if (typeof elementKey === "symbol") {
      switch (elementKey) {
        case Symbol.toStringTag:
          return "Object";
      }
    }

    if (elementKey in Object.prototype) {
      // Accessing Object prototype methods. Todo make more precise
      trackAccess(mapProxy, ACCESS_ALL_SYMBOL);
      return Object.prototype[elementKey];
    } else if (typeof elementKey === "string") {
      // Specific field access
      trackAccess(mapProxy, elementKey);
      return deref(doc, map.get(elementKey) ?? null);
    }
  },
  set({doc, type, mapProxy, map, projectId}, elementKey, value) {
    const docProjectId = doc
      .getMap<string>(YJS_GLOBALS.metadataMap)
      .get(YJS_GLOBALS.metadataMapFields.projectId);
    if (projectId !== docProjectId) {
      console.warn(
        `cannot set property ${elementKey.toString()} of ${type} as it's readonly dependency reference`
      );
      return false;
    }
    if (typeof elementKey === "string") {
      trackModification(mapProxy, elementKey);
      if (value != null) {
        map.set(elementKey, maybeReference(value, projectId, doc));
        return true;
      } else {
        trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
        map.delete(elementKey);
        return true;
      }
    }
    console.warn(`cannot set property ${elementKey.toString()} of ${type} as it's non-declared`);
    return false;
  },
  deleteProperty({map, doc, projectId, type, mapProxy}, elementKey) {
    // noinspection SuspiciousTypeOfGuard
    if (typeof elementKey === "symbol") {
      return false;
    }
    if (map.has(elementKey)) {
      const docProjectId = doc
        .getMap<string>(YJS_GLOBALS.metadataMap)
        .get(YJS_GLOBALS.metadataMapFields.projectId);
      if (projectId !== docProjectId) {
        console.warn(
          `cannot delete property ${elementKey} of ${type} as it's readonly dependency reference`
        );
        return false;
      }
      trackModification(mapProxy, ACCESS_INDICES_SET_SYMBOL);
      map.delete(elementKey);
      return true;
    }
    console.warn(`cannot delete property ${elementKey} of ${type} as it's non-declared`);
    return false;
  },
  // todo getOwnPropertyDescriptor
  setPrototypeOf() {
    return false;
  },
  has({mapProxy, map}, elementKey) {
    if (typeof elementKey === "string") {
      trackAccess(mapProxy, elementKey);
      return map.has(elementKey);
    }
    return false;
  },
  ownKeys({mapProxy, map}) {
    trackAccess(mapProxy, ACCESS_INDICES_SET_SYMBOL);
    return [...map.keys()];
  },
  getPrototypeOf() {
    return Object.prototype;
  },
  isExtensible(): boolean {
    return true;
  }
}
