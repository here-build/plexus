import * as Y from "yjs";

import { deref } from "../deref.js";
import type { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import { materializationSymbol } from "../proxy-runtime-types.js";
import { ACCESS_ALL_SYMBOL, ACCESS_INDICES_SET_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { deserializeKey, serializeKey } from "./key-serialization.js";
import { PathMap } from "./PathMap.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";

// Re-export for backward compatibility
export { serializeKey } from "./key-serialization.js";

export type MaterializedMapProxyInitTarget = {
  owner: PlexusModel;
  key: string;
};

export const buildMapProxy = <K extends AllowedYJSMapKey, V extends AllowedYJSValue>({
  owner,
  key,
}: MaterializedMapProxyInitTarget) => {
  const getYjsMap = () => {
    const yjsMap = owner.__yjsFieldsMap__?.get(key) as Y.Map<AllowedYValue> | null;
    if (yjsMap) {
      return yjsMap;
    }
    if (owner.__doc__ && owner.__yjsFieldsMap__) {
      const map = new Y.Map<AllowedYValue>();
      owner.__yjsFieldsMap__.set(key, map);
      return map;
    }
    return null;
  };

  // PathMap handles structural key equality with trie + WeakRefs
  const backingStorage = new PathMap<K, V>();

  // Map from serialized keys to PathMap keys (for YJS observer sync)
  const serializedToKey = new Map<string, K>();

  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const yjsMap = getYjsMap();
    if (event.target !== yjsMap || !yjsMap.doc) {
      return;
    }
    for (const serializedKey of event.keysChanged) {
      if (yjsMap.has(serializedKey)) {
        // Added or updated
        const deserializedKey = deserializeKey(serializedKey, yjsMap.doc) as K;
        const value = deref(yjsMap.doc, yjsMap.get(serializedKey)) as V;
        backingStorage.set(deserializedKey, value);
        serializedToKey.set(serializedKey, deserializedKey);
        // Use canonical key for tracking (matches what get() uses)
        trackModification(self, backingStorage.getCanonicalKey(deserializedKey));
      } else {
        // Deleted
        const originalKey = serializedToKey.get(serializedKey);
        if (originalKey) {
          // Get canonical key before delete (delete preserves it as WeakRef)
          const canonicalKey = backingStorage.getCanonicalKey(originalKey);
          backingStorage.delete(originalKey);
          serializedToKey.delete(serializedKey);
          trackModification(self, canonicalKey);
        }
      }
    }
    trackModification(self, ACCESS_INDICES_SET_SYMBOL);
  };

  // Initialize from existing Y.Map if present
  {
    const map = getYjsMap();
    if (map?.doc) {
      map.observe(observer);
      undoManagerNotifications.set(map, observer);
      for (const [serializedKey, v] of map.entries()) {
        const deserializedKey = deserializeKey(serializedKey, map.doc) as K;
        backingStorage.set(deserializedKey, deref(map.doc, v) as V);
        serializedToKey.set(serializedKey, deserializedKey);
      }
    }
  }

  const mapLike = {
    get size() {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return backingStorage.size;
    },

    get(this: Map<K, V>, mapKey: K): V | undefined {
      trackAccess(owner, key);
      trackAccess(self, backingStorage.getCanonicalKey(mapKey));
      return backingStorage.get(mapKey);
    },

    set(this: Map<K, V>, mapKey: K, value: V): Map<K, V> {
      if (backingStorage.get(mapKey) === value) {
        return this;
      }
      maybeTransacting(owner.__doc__, () => {
        const hadKey = backingStorage.has(mapKey);
        backingStorage.set(mapKey, value);

        // Write to Y.Map if connected
        const yjsMap = getYjsMap();
        if (yjsMap && owner.__doc__) {
          const serializedKey = serializeKey(mapKey, owner.__doc__);
          serializedToKey.set(serializedKey, mapKey);
          yjsMap.set(serializedKey, maybeReference(value, owner.__doc__));
        }

        trackModification(self, backingStorage.getCanonicalKey(mapKey));
        if (!hadKey) {
          trackModification(self, ACCESS_INDICES_SET_SYMBOL);
        }
      });
      return self;
    },

    has(mapKey: K): boolean {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      return backingStorage.has(mapKey);
    },

    delete(mapKey: K): boolean {
      if (!backingStorage.has(mapKey)) {
        return false;
      }
      return maybeTransacting(owner.__doc__, () => {
        backingStorage.delete(mapKey);
        if (owner.__doc__) {
          const serializedKey = serializeKey(mapKey, owner.__doc__);
          serializedToKey.delete(serializedKey);
          getYjsMap()?.delete(serializedKey);
        }

        trackModification(self, backingStorage.getCanonicalKey(mapKey));
        trackModification(self, ACCESS_INDICES_SET_SYMBOL);
        return true;
      });
    },

    clear(): void {
      if (backingStorage.size === 0) {
        return;
      }
      maybeTransacting(owner.__doc__, () => {
        backingStorage.clear();
        serializedToKey.clear();
        getYjsMap()?.clear();
        trackModification(self, ACCESS_ALL_SYMBOL);
      });
    },

    *keys(): MapIterator<K> {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_INDICES_SET_SYMBOL);
      yield* backingStorage.keys();
    },

    *values(): MapIterator<V> {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_ALL_SYMBOL);
      yield* backingStorage.values();
    },

    *entries(): MapIterator<[K, V]> {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_ALL_SYMBOL);
      yield* backingStorage.entries();
    },

    forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
      trackAccess(owner, key);
      trackAccess(self, ACCESS_ALL_SYMBOL);
      for (const [k, v] of backingStorage.entries()) {
        callback.call(thisArg, v, k, self);
      }
    },

    [Symbol.iterator](): MapIterator<[K, V]> {
      return this.entries();
    },

    [Symbol.toStringTag]: "Map",

    // Plexus-specific methods
    assign(entries: Iterable<[K, V]> | Record<string, V>): void {
      maybeTransacting(owner.__doc__, () => {
        const iterable =
          Symbol.iterator in entries ? (entries as Iterable<[K, V]>) : (Object.entries(entries) as Iterable<[K, V]>);

        // Prep new data first (best-effort atomicity)
        const newEntries: [K, V][] = [...iterable];
        const newSerializedEntries: [string, K, AllowedYValue][] = [];
        const yjsMap = getYjsMap();
        if (yjsMap && owner.__doc__) {
          for (const [k, v] of newEntries) {
            newSerializedEntries.push([serializeKey(k, owner.__doc__), k, maybeReference(v, owner.__doc__)]);
          }
        }

        // Now clear and apply
        backingStorage.clear();
        serializedToKey.clear();
        yjsMap?.clear();

        for (const [k, v] of newEntries) {
          backingStorage.set(k, v);
        }
        for (const [serializedKey, k, yjsValue] of newSerializedEntries) {
          serializedToKey.set(serializedKey, k);
          yjsMap?.set(serializedKey, yjsValue);
        }

        trackModification(self, ACCESS_ALL_SYMBOL);
      });
    },

    [materializationSymbol](): void {
      const map = getYjsMap();
      if (!map?.doc) return;

      backingStorage.clear();
      serializedToKey.clear();

      for (const [serializedKey, v] of map.entries()) {
        const deserializedKey = deserializeKey(serializedKey, map.doc) as K;
        backingStorage.set(deserializedKey, deref(map.doc!, v) as V);
        serializedToKey.set(serializedKey, deserializedKey);
      }

      map.observe(observer);
      undoManagerNotifications.set(map, observer);
    },
  };
  Reflect.setPrototypeOf(mapLike, Map.prototype);
  Object.freeze(mapLike);

  const self = mapLike as unknown as Map<K, V> & ReadonlyField<Map<K, V>>;
  return self;
};
