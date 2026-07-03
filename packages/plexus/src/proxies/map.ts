import { PathMap } from "@here.build/collections";
import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { isInCloneTransaction } from "../clone.js";
import { deref } from "../deref.js";
import { emitOrDefer, isDeferring, isLiminalDoc, type OwnershipMove, type YjsOp } from "../action-buffer.js";
import { PlexusModel } from "../PlexusModel.js";
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
import { deserializeKey, materializeKeyEntities, serializeKey, serializeKeyNonMinting } from "./key-serialization.js";
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
        // STALE-MEMBERSHIP RULE: mid-region the backing map can be stale — the
        // value may already have been staged to a DIFFERENT parent by a later
        // statement elsewhere, even though this map's backing still shows it
        // here. Declare the reaffirmation as a moves-only emit so the squash
        // sees THIS statement as the last word; the engine no-ops it when it's
        // a true reaffirmation. Non-child fields keep the cheap early return.
        // Gated on a deferring receiver (mirroring record.set): on the instant
        // path there is no squash to win, so the plain early return stands.
        if (isChildField && value instanceof PlexusModel && isDeferring() && owner.__doc__ && !isLiminalDoc(owner.__doc__)) {
          const serializedSubKey = serializeKeyNonMinting(mapKey, owner.__doc__);
          emitOrDefer(owner.__doc__, {
            applyNow: () => {},
            overlay: () => {},
            describe: () => [],
            revertOverlay: () => {},
            moves: [{ child: value, parent: owner, field: key, meta: serializedSubKey, rawKey: mapKey }],
          });
        }
        return this;
      }
      // Captured BEFORE overlay mutates backingStorage — they feed the orphan
      // move right below and `notify`/`revertOverlay`, which run at flush time
      // (or on rollback), when backingStorage already reflects the new value.
      const hadKey = backingStorage.has(mapKey);
      const oldValue = backingStorage.get(mapKey);
      // Statement-time serialization, shared by the move and the ops below.
      // Non-minting: a fresh entity key must not do doc work (genesis) at
      // statement time — flush phase 1 materializes it, and settle/describe
      // re-serialize the global form from the raw key.
      const serializedSubKey = isChildField ? serializeKeyNonMinting(mapKey, owner.__doc__) : null;
      const stagedMoves: OwnershipMove[] = [];
      if (isChildField) {
        if (oldValue instanceof PlexusModel && oldValue !== value) {
          stagedMoves.push({ child: oldValue, orphan: true, from: { parent: owner, field: key, meta: serializedSubKey } });
        }
        if (value instanceof PlexusModel) {
          stagedMoves.push({ child: value, parent: owner, field: key, meta: serializedSubKey, rawKey: mapKey });
        }
      }
      emitOrDefer(owner.__doc__, {
        // Non-action path: the original choreography — verbatim modulo the
        // residence guard, which is vacuous eagerly (a resident occupant
        // always passes) and only bites when a flush-time sweep re-enters
        // this proxy.
        applyNow: () => {
          ensureYjsMap();
          maybeTransacting(owner.__doc__, () => {
            const hadKey = backingStorage.has(mapKey);

            // Handle child tracking - VALIDATE FIRST, then orphan old value, adopt new value
            if (isChildField) {
              const serializedSubKey = serializeKey(mapKey, owner.__doc__);
              // Validate adoption BEFORE any state changes (throws on cycle)
              value?.[validateAdoptionSymbol]?.(owner, key, serializedSubKey);

              // Now safe to orphan old value (only if it actually RESIDES here —
              // a flush-time sweep re-enters this proxy for content-only
              // removals) and adopt new one
              const oldValue = backingStorage.get(mapKey);
              if (oldValue instanceof PlexusModel && oldValue.parent === owner && oldValue.parentField === key) {
                oldValue[requestOrphanizationSymbol]?.();
              }
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
          // `materialize` (phase 1); old-value orphanization + the parent edge
          // settle once at flush via the staged `moves` (ownership pass) —
          // `describe` stays content-only.
          if (isChildField) {
            value?.[validateAdoptionSymbol]?.(owner, key, serializedSubKey!);
          }
          backingStorage.set(mapKey, value);
        },
        materialize: () => {
          // Phase 1 — GENESIS of the CHILD entity, run OUTSIDE the flush
          // transaction so its materialization keeps its own origin.
          if (isChildField) {
            value?.[referenceSymbol]?.(owner.__doc__!);
          }
          // Key entities materialize UNCONDITIONALLY — value maps admit entity
          // keys too, and describe() serializes the key inside the flush tx.
          materializeKeyEntities(mapKey, owner.__doc__!);
        },
        describe: () => {
          // Phase 2 — content-only. Ownership choreography (orphan/adopt) is
          // declared via `moves` above and settled once by the flush ownership
          // pass; this returns only the leaf field-map write.
          ensureYjsMap();
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
        moves: stagedMoves,
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
      // Captured BEFORE overlay removes the entry — they feed the orphan move
      // below and `notify`/`revertOverlay`, which run at flush time (or on
      // rollback), after backingStorage already lost it.
      const oldValue = backingStorage.get(mapKey);
      const canonicalKey = backingStorage.getCanonicalKey(mapKey);
      // Statement-time serialization — the same string form the orphan move's
      // `meta` carries, computed once here. Non-minting: deleting under a
      // fresh entity key must not materialize it.
      const serializedSubKey = isChildField ? serializeKeyNonMinting(mapKey, owner.__doc__) : null;
      emitOrDefer(owner.__doc__, {
        // Non-action path: the original choreography — verbatim modulo the
        // residence guard, which is vacuous eagerly (a resident occupant
        // always passes) and only bites when a flush-time sweep re-enters
        // this proxy.
        applyNow: () => {
          maybeTransacting(owner.__doc__, () => {
            // Handle child tracking - orphan the value being deleted, but only
            // if it actually RESIDES here (a flush-time sweep re-enters this
            // proxy for content-only removals).
            if (isChildField) {
              const oldValue = backingStorage.get(mapKey);
              if (oldValue instanceof PlexusModel && oldValue.parent === owner && oldValue.parentField === key) {
                oldValue[informOrphanizationSymbol]?.();
              }
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
          // Phase 2 — content-only. Ownership choreography (orphan) is
          // declared via `moves` below and settled once by the flush
          // ownership pass; this returns only the leaf field-map write.
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
        moves:
          isChildField && oldValue instanceof PlexusModel
            ? [{ child: oldValue, orphan: true, from: { parent: owner, field: key, meta: serializedSubKey } }]
            : undefined,
      });
      return true;
    },

    clear(): void {
      invariant(!virtualFactory, "VirtualMap: .clear() is blocked — virtual children cannot be removed");
      if (backingStorage.size === 0) {
        return;
      }
      // Snapshotted BEFORE overlay empties backingStorage — it feeds the orphan
      // moves right below and the silent rollback restore in `revertOverlay`.
      const priorEntries: [K, V][] | undefined = isDeferring() ? [...backingStorage.entries()] : undefined;
      // Statement-time per-entry serialization — each orphan move's `from.meta`
      // needs the key its child was filed under, computed once here.
      const stagedMoves: OwnershipMove[] | undefined =
        isChildField && priorEntries
          ? priorEntries
              .filter((entry): entry is [K, V & PlexusModel] => entry[1] instanceof PlexusModel)
              .map(([k, value]) => ({
                child: value,
                orphan: true as const,
                from: { parent: owner, field: key, meta: serializeKeyNonMinting(k, owner.__doc__) },
              }))
          : undefined;
      emitOrDefer(owner.__doc__, {
        // Non-action path: the original choreography — verbatim modulo the
        // residence guard, which is vacuous eagerly (a resident occupant
        // always passes) and only bites when a flush-time sweep re-enters
        // this proxy.
        applyNow: () => {
          maybeTransacting(owner.__doc__, () => {
            // Handle child tracking - orphan all values that actually RESIDE
            // here (a flush-time sweep re-enters this proxy for content-only
            // removals).
            if (isChildField) {
              for (const value of backingStorage.values()) {
                if (value instanceof PlexusModel && value.parent === owner && value.parentField === key) {
                  value[informOrphanizationSymbol]?.();
                }
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
          // Phase 2 — content-only. Ownership choreography (orphan) is
          // declared via `moves` below and settled once by the flush
          // ownership pass; this returns only the leaf field-map write.
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
          if (!priorEntries) return;
          for (const [k, v] of priorEntries) {
            backingStorage.set(k, v);
          }
        },
        moves: stagedMoves,
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
      const newEntries: [K, V][] | undefined = isDeferring() ? [...map.entries()] : undefined;
      const priorEntries: [K, V][] | undefined = isDeferring() ? [...backingStorage.entries()] : undefined;
      const oldValueSet = isDeferring() ? new Set(backingStorage.values()) : undefined;
      const newValueSet = newEntries ? new Set(newEntries.map(([_, v]) => v)) : undefined;

      // Ownership FACTS for the squash, statement-time serialized into each
      // move's `meta` (`describe()` re-serializes the keys inside the flush tx;
      // phase-1 key materialization guarantees the forms agree). Every model
      // VALUE in the new
      // entries declares adopt — even KEPT ones — because mid-region the
      // backing map can be stale (the value may be staged elsewhere by a
      // later statement); the engine no-ops true reaffirmations. Every model
      // value dropped from the old set (not present in the new set) declares
      // orphan-with-from, naming the slot (key) it's leaving.
      let stagedMoves: OwnershipMove[] | undefined;
      if (isChildField && newEntries && priorEntries && oldValueSet && newValueSet) {
        stagedMoves = [];
        for (const value of oldValueSet) {
          if (value instanceof PlexusModel && !newValueSet.has(value)) {
            // Find the key(s) this value was filed under prior to assign.
            for (const [k, v] of priorEntries) {
              if (v === value) {
                stagedMoves.push({
                  child: value,
                  orphan: true,
                  from: { parent: owner, field: key, meta: serializeKeyNonMinting(k, owner.__doc__) },
                });
              }
            }
          }
        }
        for (const [k, v] of newEntries) {
          if (v instanceof PlexusModel) {
            const serializedSubKey = serializeKeyNonMinting(k, owner.__doc__);
            stagedMoves.push({ child: v, parent: owner, field: key, meta: serializedSubKey, rawKey: k });
          }
        }
      }

      emitOrDefer(owner.__doc__, {
        // Non-action path: the original choreography — verbatim modulo the
        // residence guard, which is vacuous eagerly (a resident occupant
        // always passes) and only bites when a flush-time sweep re-enters
        // this proxy.
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

              // Now safe to orphan values that aren't in the new set — but only
              // if they actually RESIDE here (a flush-time sweep re-enters
              // this proxy for content-only removals).
              for (const value of oldValueSet) {
                if (
                  value instanceof PlexusModel &&
                  !newValueSet.has(value) &&
                  value.parent === owner &&
                  value.parentField === key
                ) {
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
          if (!newEntries || !oldValueSet) return;
          // Fail-fast on illegal adoption for truly-new child values, BEFORE any
          // state change — pure check, no yjs write. Genesis deferred to
          // `materialize` (phase 1); old-value orphanization + the parent edges
          // settle once at flush via the staged `moves` (ownership pass) —
          // `describe` stays content-only.
          if (isChildField) {
            for (const [k, v] of newEntries) {
              if (v && !oldValueSet.has(v)) {
                const serializedSubKey = serializeKeyNonMinting(k, owner.__doc__);
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
          if (!newEntries || !oldValueSet) return;
          // Phase 1 — GENESIS for truly-new CHILD values, run OUTSIDE the flush
          // transaction so each keeps its own origin.
          if (isChildField) {
            for (const [, v] of newEntries) {
              if (v && !oldValueSet.has(v)) {
                v?.[referenceSymbol]?.(owner.__doc__!);
              }
            }
          }
          // Key entities materialize UNCONDITIONALLY — value maps admit entity
          // keys too, and describe() serializes each key inside the flush tx.
          for (const [k] of newEntries) {
            materializeKeyEntities(k, owner.__doc__!);
          }
        },
        describe: () => {
          // Phase 2 — content-only. Ownership choreography (orphan/adopt) is
          // declared via `moves` below and settled once by the flush
          // ownership pass; this returns only the leaf field-map writes — a
          // clear followed by N sets.
          ensureYjsMap();
          const yjsMap = getYjsMap();
          if (!yjsMap || !owner.__doc__ || !newEntries) return [];
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
          if (!priorEntries) return;
          backingStorage.clear();
          for (const [k, v] of priorEntries) {
            backingStorage.set(k, v);
          }
        },
        moves: stagedMoves,
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
