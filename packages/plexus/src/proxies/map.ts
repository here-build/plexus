import { PathMap } from "@here.build/collections";
import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { isInCloneTransaction } from "../clone.js";
import { deref } from "../deref.js";
import { emitOrDefer, type YjsOp } from "../action-buffer.js";
import type { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  referenceSymbol,
  requestAdoptionSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import {
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  KEYS_SYMBOL,
  trackAccess,
  trackModification,
  VALUES_SYMBOL,
} from "../tracking.js";
import { deserializeKey, serializeKey } from "./key-serialization.js";
import { bucketCount, telemetry } from "../telemetry.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeVirtualChild, materializeMapForField } from "../virtual-children-genesis.js";

// Re-export for backward compatibility
export { serializeKey, deserializeKey } from "./key-serialization.js";

export type MaterializedMapProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
  virtualFactory?: (key: any) => PlexusModel;
};

export const buildMapProxy = <K extends AllowedYJSMapKey, V extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
  virtualFactory,
}: MaterializedMapProxyInitTarget) => {
  const getYjsMap = (): Y.Map<AllowedYValue> | null => {
    return (owner.__yjsFieldsMap__?.get(key) as Y.Map<AllowedYValue>) ?? null;
  };

  const attachObserver = (map: Y.Map<AllowedYValue>) => {
    if (undoManagerNotifications.has(map)) return;
    map.observe(observer);
    undoManagerNotifications.set(map, observer);
  };

  const ensureYjsMap = (): Y.Map<AllowedYValue> | null => {
    const existing = getYjsMap();
    if (existing) return existing;
    if (!owner.__doc__ || !owner.__yjsFieldsMap__) return null;
    const map = materializeMapForField(owner, key);
    attachObserver(map);
    return map;
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
    if (telemetry.enabled) {
      telemetry.histogram("plexus.collection.observer_diff_size", event.keysChanged.size, {
        collection_kind: "map",
        is_child_field: isChildField ? "true" : "false",
        new_length_bucket: bucketCount(yjsMap.size),
      });
      if (event.keysChanged.size === 0) {
        telemetry.counter("plexus.collection.observer_no_effect", { collection_kind: "map" });
      }
    }

    let keysChanged = false;
    let valuesChanged = false;

    for (const serializedKey of event.keysChanged) {
      const hadKeyBefore = serializedToKey.has(serializedKey);
      const hasKeyNow = yjsMap.has(serializedKey);

      if (hasKeyNow) {
        // Added or updated
        const deserializedKey = deserializeKey(serializedKey, yjsMap.doc) as K;
        const value = deref(yjsMap.doc, yjsMap.get(serializedKey)) as V;

        // Handle child tracking for remote changes
        if (isChildField) {
          // Orphan the old value if being replaced
          if (hadKeyBefore) {
            const oldValue = backingStorage.get(deserializedKey);
            oldValue?.[informOrphanizationSymbol]?.();
          }
          // Adopt the new value (use inform since remote changes can't be rejected)
          value?.[informAdoptionSymbol]?.(owner, key, serializedKey);
        }

        backingStorage.set(deserializedKey, value);
        serializedToKey.set(serializedKey, deserializedKey);
        // Use canonical key for tracking (matches what get() uses)
        trackModification(self, backingStorage.getCanonicalKey(deserializedKey));

        if (!hadKeyBefore) {
          keysChanged = true; // Key was added
        }
        valuesChanged = true; // Value was set (added or updated)
      } else {
        // Deleted
        const originalKey = serializedToKey.get(serializedKey);
        if (originalKey) {
          // Handle child tracking for remote deletions
          if (isChildField) {
            const oldValue = backingStorage.get(originalKey);
            oldValue?.[informOrphanizationSymbol]?.();
          }

          // Get canonical key before delete (delete preserves it as WeakRef)
          const canonicalKey = backingStorage.getCanonicalKey(originalKey);
          backingStorage.delete(originalKey);
          serializedToKey.delete(serializedKey);
          trackModification(self, canonicalKey);
          keysChanged = true; // Key was deleted
          valuesChanged = true; // Value was removed
        }
      }
    }

    if (valuesChanged) {
      trackModification(self, VALUES_SYMBOL);
    }
    if (keysChanged) {
      trackModification(self, KEYS_SYMBOL);
      trackModification(self, ENTRIES_LENGTH_SYMBOL);
    }
  };

  // Initialize from existing Y.Map if present
  {
    const map = getYjsMap();
    if (map?.doc) {
      attachObserver(map);
      // some runtimes like wrangler act weird on Y.Map.entries()
      for (const [serializedKey, v] of map.entries()) {
        const deserializedKey = deserializeKey(serializedKey, map.doc!) as K;
        backingStorage.set(deserializedKey, deref(map.doc!, v) as V);
        serializedToKey.set(serializedKey, deserializedKey);
      }
    }
  }

  type This = Map<K, V> & ReadonlyField<Map<K, V>>;

  const self: This = {
    get size() {
      trackAccess(owner, key);
      trackAccess(self, ENTRIES_LENGTH_SYMBOL);
      return backingStorage.size;
    },

    get(this: This, mapKey: K): V | undefined {
      trackAccess(owner, key);
      trackAccess(self, backingStorage.getCanonicalKey(mapKey));
      if (virtualFactory && !backingStorage.has(mapKey)) {
        ensureYjsMap();
        const yjsMap = getYjsMap();
        invariant(yjsMap, "VirtualMap: owner must be connected to a doc");
        materializeVirtualChild(owner, key, mapKey, yjsMap, virtualFactory);
      }
      return backingStorage.get(mapKey);
    },

    set(this: This, mapKey: K, value: V): This {
      invariant(!virtualFactory, "VirtualMap: .set() is blocked — use .get(key) to auto-materialize");
      if (backingStorage.get(mapKey) === value) {
        return this;
      }
      // Captured BEFORE overlay mutates backingStorage — `describe`/`revertOverlay`
      // run at flush time (or on rollback), when backingStorage already reflects
      // the new value, so the pre-op state must be snapshotted here.
      const hadKey = backingStorage.has(mapKey);
      const oldValue = backingStorage.get(mapKey);
      emitOrDefer(owner.__doc__, {
        // Non-action path: exactly the original choreography, verbatim.
        applyNow: () => {
          ensureYjsMap();
          maybeTransacting(owner.__doc__, () => {
            const hadKey = backingStorage.has(mapKey);

            // Handle child tracking - VALIDATE FIRST, then orphan old value, adopt new value
            if (isChildField) {
              const serializedSubKey = serializeKey(mapKey, owner.__doc__);
              // Validate adoption BEFORE any state changes (throws on cycle)
              value?.[validateAdoptionSymbol]?.(owner, key, serializedSubKey);

              // Now safe to orphan old value and adopt new one
              const oldValue = backingStorage.get(mapKey);
              oldValue?.[requestOrphanizationSymbol]?.();
              value?.[requestAdoptionSymbol]?.(owner, key, serializedSubKey);
            }

            backingStorage.set(mapKey, value);

            // Write to Y.Map if connected
            const yjsMap = getYjsMap();
            if (yjsMap && owner.__doc__) {
              const serializedKey = serializeKey(mapKey, owner.__doc__);
              serializedToKey.set(serializedKey, mapKey);
              yjsMap.set(serializedKey, maybeReference(value, owner.__doc__));
            }

            trackModification(self, backingStorage.getCanonicalKey(mapKey));
            trackModification(self, VALUES_SYMBOL);
            if (!hadKey) {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
            }
          });
        },
        overlay: () => {
          // Fail-fast on illegal adoption (cycle, cross-doc, self) BEFORE any state
          // change — pure check, no yjs write. Materialization deferred to
          // `materialize` (phase 1); old-value orphanization + parent-edge write
          // deferred to `describe` (phase 2, both real transitive writes).
          if (isChildField) {
            const serializedSubKey = serializeKey(mapKey, owner.__doc__);
            value?.[validateAdoptionSymbol]?.(owner, key, serializedSubKey);
          }
          backingStorage.set(mapKey, value);
        },
        materialize: () => {
          // Phase 1 — GENESIS of the CHILD entity, run OUTSIDE the flush
          // transaction so its materialization keeps its own origin.
          if (isChildField) {
            value?.[referenceSymbol]?.(owner.__doc__!);
          }
        },
        describe: () => {
          // Phase 2 — the child (if any) is already materialized (phase 1). Run
          // the transitive core prep (owner field-map genesis, old-value
          // orphanization, parent-edge adoption) as calls, then RETURN the leaf
          // field-map write as a `map-set` op.
          ensureYjsMap();
          if (isChildField) {
            const serializedSubKey = serializeKey(mapKey, owner.__doc__);
            oldValue?.[requestOrphanizationSymbol]?.();
            value?.[requestAdoptionSymbol]?.(owner, key, serializedSubKey);
          }
          const yjsMap = getYjsMap();
          if (!yjsMap || !owner.__doc__) return [];
          const serializedKey = serializeKey(mapKey, owner.__doc__);
          serializedToKey.set(serializedKey, mapKey);
          return [{ kind: "map-set", map: yjsMap, key: serializedKey, value: maybeReference(value, owner.__doc__) }];
        },
        notify: () => {
          trackModification(self, backingStorage.getCanonicalKey(mapKey));
          trackModification(self, VALUES_SYMBOL);
          if (!hadKey) {
            trackModification(self, KEYS_SYMBOL);
            trackModification(self, ENTRIES_LENGTH_SYMBOL);
          }
        },
        revertOverlay: () => {
          // Silent restore of the pre-op backing value. The overlay `set` fired no
          // `trackModification` (deferred to `notify`), so undoing it must be
          // silent too, or we'd fire a spurious re-run for a net-zero change.
          if (hadKey) {
            backingStorage.set(mapKey, oldValue as V);
          } else {
            backingStorage.delete(mapKey);
          }
        },
      });
      return self;
    },

    has(mapKey: K): boolean {
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      return backingStorage.has(mapKey);
    },

    getOrInsert(mapKey: K, defaultValue: V): V {
      const existing = backingStorage.get(mapKey);
      if (existing !== undefined || backingStorage.has(mapKey)) return existing!;
      this.set(mapKey, defaultValue);
      return defaultValue;
    },

    getOrInsertComputed(mapKey: K, callbackfn: (key: K) => V): V {
      const existing = backingStorage.get(mapKey);
      if (existing !== undefined || backingStorage.has(mapKey)) return existing!;
      const value = callbackfn(mapKey);
      this.set(mapKey, value);
      return value;
    },

    delete(mapKey: K): boolean {
      invariant(!virtualFactory, "VirtualMap: .delete() is blocked — virtual children cannot be removed");
      if (!backingStorage.has(mapKey)) {
        return false;
      }
      // Captured BEFORE overlay removes the entry — `describe`/`revertOverlay`
      // run at flush time (or on rollback), after backingStorage already lost it.
      const oldValue = backingStorage.get(mapKey);
      const canonicalKey = backingStorage.getCanonicalKey(mapKey);
      emitOrDefer(owner.__doc__, {
        // Non-action path: exactly the original choreography, verbatim.
        applyNow: () => {
          maybeTransacting(owner.__doc__, () => {
            // Handle child tracking - orphan the value being deleted
            if (isChildField) {
              const oldValue = backingStorage.get(mapKey);
              oldValue?.[informOrphanizationSymbol]?.();
            }

            // Get canonical key before delete (delete preserves it as WeakRef)
            const canonicalKey = backingStorage.getCanonicalKey(mapKey);
            backingStorage.delete(mapKey);
            if (owner.__doc__) {
              const serializedKey = serializeKey(mapKey, owner.__doc__);
              serializedToKey.delete(serializedKey);
              getYjsMap()?.delete(serializedKey);
            }

            trackModification(self, canonicalKey);
            trackModification(self, VALUES_SYMBOL);
            trackModification(self, KEYS_SYMBOL);
            trackModification(self, ENTRIES_LENGTH_SYMBOL);
            return true;
          });
        },
        overlay: () => {
          backingStorage.delete(mapKey);
        },
        describe: () => {
          // Orphanization is transitive core (a real write) — run it here,
          // matching where the original ran it (before the delete), NOT in overlay.
          if (isChildField) {
            oldValue?.[informOrphanizationSymbol]?.();
          }
          if (!owner.__doc__) return [];
          const serializedKey = serializeKey(mapKey, owner.__doc__);
          serializedToKey.delete(serializedKey);
          const yjsMap = getYjsMap();
          if (!yjsMap) return [];
          return [{ kind: "map-delete", map: yjsMap, key: serializedKey }];
        },
        notify: () => {
          trackModification(self, canonicalKey);
          trackModification(self, VALUES_SYMBOL);
          trackModification(self, KEYS_SYMBOL);
          trackModification(self, ENTRIES_LENGTH_SYMBOL);
        },
        revertOverlay: () => {
          // Silently restore the deleted entry.
          backingStorage.set(mapKey, oldValue as V);
        },
      });
      return true;
    },

    clear(): void {
      invariant(!virtualFactory, "VirtualMap: .clear() is blocked — virtual children cannot be removed");
      if (backingStorage.size === 0) {
        return;
      }
      // Snapshotted BEFORE overlay empties backingStorage — used both for the
      // deferred orphanization loop (`describe`) and the silent rollback restore.
      const priorEntries: [K, V][] = [...backingStorage.entries()];
      emitOrDefer(owner.__doc__, {
        // Non-action path: exactly the original choreography, verbatim.
        applyNow: () => {
          maybeTransacting(owner.__doc__, () => {
            // Handle child tracking - orphan all values
            if (isChildField) {
              for (const value of backingStorage.values()) {
                value?.[informOrphanizationSymbol]?.();
              }
            }

            backingStorage.clear();
            serializedToKey.clear();
            getYjsMap()?.clear();
            trackModification(self, ACCESS_ALL_SYMBOL);
          });
        },
        overlay: () => {
          backingStorage.clear();
        },
        describe: () => {
          // Orphanization is transitive core (real writes) — run it here, matching
          // where the original ran it (before the clear), NOT in overlay.
          if (isChildField) {
            for (const [, value] of priorEntries) {
              value?.[informOrphanizationSymbol]?.();
            }
          }
          serializedToKey.clear();
          const yjsMap = getYjsMap();
          if (!yjsMap) return [];
          return [{ kind: "map-clear", map: yjsMap }];
        },
        notify: () => {
          trackModification(self, ACCESS_ALL_SYMBOL);
        },
        revertOverlay: () => {
          // Silently restore the pre-clear backing contents.
          for (const [k, v] of priorEntries) {
            backingStorage.set(k, v);
          }
        },
      });
    },

    *keys(): MapIterator<K> {
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      yield* backingStorage.keys();
    },

    *values(): MapIterator<V> {
      trackAccess(owner, key);
      trackAccess(self, VALUES_SYMBOL);
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
    assign(map: Map<K, V>): void {
      if (virtualFactory) {
        invariant(
          isInCloneTransaction(),
          "VirtualMap: .assign() is blocked outside clone — virtual children are factory-created",
        );
      }
      // Computed BEFORE overlay replaces backingStorage's contents — `overlay`,
      // `materialize`, `describe`, and `revertOverlay` all need the same
      // old/new snapshots, and by flush time backingStorage already holds the
      // new entries.
      const newEntries: [K, V][] = [...map.entries()];
      const priorEntries: [K, V][] = [...backingStorage.entries()];
      const oldValueSet = new Set(backingStorage.values());
      const newValueSet = new Set(newEntries.map(([_, v]) => v));

      emitOrDefer(owner.__doc__, {
        // Non-action path: exactly the original choreography, verbatim.
        applyNow: () => {
          ensureYjsMap();
          maybeTransacting(owner.__doc__, () => {
            const iterable = map.entries();

            // Prep new data first (best-effort atomicity)
            const newEntries: [K, V][] = [...iterable];

            // For child fields, calculate what needs to be adopted/orphaned
            // and VALIDATE all adoptions BEFORE any state changes
            const oldValueSet = new Set(backingStorage.values());
            const newValueSet = new Set(newEntries.map(([_, v]) => v));

            if (isChildField) {
              // VALIDATE FIRST: Check all truly new values can be adopted
              for (const [k, v] of newEntries) {
                if (v && !oldValueSet.has(v)) {
                  const serializedSubKey = serializeKey(k, owner.__doc__);
                  v[validateAdoptionSymbol]?.(owner, key, serializedSubKey);
                }
              }

              // Now safe to orphan values that aren't in the new set
              for (const value of oldValueSet) {
                if (value && !newValueSet.has(value)) {
                  value[informOrphanizationSymbol]?.();
                }
              }
            }

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

            // Handle child tracking - adopt all truly new values
            // Iterate newEntries (not newSerializedEntries) so adoption works in ephemeral mode too
            if (isChildField) {
              for (const [k, v] of newEntries) {
                if (v && !oldValueSet.has(v)) {
                  const serializedSubKey = serializeKey(k, owner.__doc__);
                  v[requestAdoptionSymbol]?.(owner, key, serializedSubKey);
                }
              }
            }

            trackModification(self, ACCESS_ALL_SYMBOL);
          });
        },
        overlay: () => {
          // Fail-fast on illegal adoption for truly-new child values, BEFORE any
          // state change — pure check, no yjs write. Genesis deferred to
          // `materialize`; old-value orphanization + parent-edge writes deferred
          // to `describe` (both real transitive writes).
          if (isChildField) {
            for (const [k, v] of newEntries) {
              if (v && !oldValueSet.has(v)) {
                const serializedSubKey = serializeKey(k, owner.__doc__);
                v[validateAdoptionSymbol]?.(owner, key, serializedSubKey);
              }
            }
          }
          backingStorage.clear();
          for (const [k, v] of newEntries) {
            backingStorage.set(k, v);
          }
        },
        materialize: () => {
          // Phase 1 — GENESIS for truly-new CHILD values, run OUTSIDE the flush
          // transaction so each keeps its own origin.
          if (isChildField) {
            for (const [, v] of newEntries) {
              if (v && !oldValueSet.has(v)) {
                v?.[referenceSymbol]?.(owner.__doc__!);
              }
            }
          }
        },
        describe: () => {
          // Phase 2 — new children are already materialized (phase 1). Run the
          // transitive core prep (owner field-map genesis, old-value
          // orphanization, parent-edge adoption), then RETURN the resulting
          // ops — a clear followed by N sets — for the engine to apply.
          ensureYjsMap();
          if (isChildField) {
            for (const value of oldValueSet) {
              if (value && !newValueSet.has(value)) {
                value[informOrphanizationSymbol]?.();
              }
            }
            for (const [k, v] of newEntries) {
              if (v && !oldValueSet.has(v)) {
                const serializedSubKey = serializeKey(k, owner.__doc__);
                v[requestAdoptionSymbol]?.(owner, key, serializedSubKey);
              }
            }
          }
          const yjsMap = getYjsMap();
          if (!yjsMap || !owner.__doc__) return [];
          const doc = owner.__doc__;
          serializedToKey.clear();
          const ops: YjsOp[] = [{ kind: "map-clear", map: yjsMap }];
          for (const [k, v] of newEntries) {
            const serializedKey = serializeKey(k, doc);
            serializedToKey.set(serializedKey, k);
            ops.push({ kind: "map-set", map: yjsMap, key: serializedKey, value: maybeReference(v, doc) });
          }
          return ops;
        },
        notify: () => {
          trackModification(self, ACCESS_ALL_SYMBOL);
        },
        revertOverlay: () => {
          // Silently restore the pre-assign backing contents.
          backingStorage.clear();
          for (const [k, v] of priorEntries) {
            backingStorage.set(k, v);
          }
        },
      });
    },

    [materializationSymbol](): void {
      const map = getYjsMap();
      if (!map?.doc) {
        backingStorage.clear();
        serializedToKey.clear();
        return;
      }

      // some runtimes like wrangler act weird on Y.Map.entries()
      for (const [serializedKey, v] of map.entries()) {
        const deserializedKey = deserializeKey(serializedKey, map.doc!) as K;
        const value = deref(map.doc!, v) as V;
        backingStorage.set(deserializedKey, value);
        serializedToKey.set(serializedKey, deserializedKey);
      }

      attachObserver(map);
    },
  };
  Reflect.setPrototypeOf(self, Map.prototype);
  Object.freeze(self);

  return self;
};
