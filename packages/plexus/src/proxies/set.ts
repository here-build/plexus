import type * as Y from "yjs";

import { emitOrDefer } from "../atomic-buffer.js";
import type { PlexusModel } from "../PlexusModel.js";
import {
  type AllowedYJSKeyValue,
  type AllowedYJSValue,
  type AllowedYValue,
  type ReadonlyField,
  informOrphanizationSymbol,
  materializationSymbol,
  referenceSymbol,
  requestAdoptionSymbol,
  validateAdoptionSymbol } from "../proxy-runtime-types.js";
import { bucketCount, telemetry } from "../telemetry.js";
import { ACCESS_ALL_SYMBOL, ENTRIES_LENGTH_SYMBOL, KEYS_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeMapForField } from "../virtual-children-genesis.js";
import { deserializeKey, serializeKey } from "./key-serialization.js";
import { type AssertNever, type MethodsOf } from "./method-classification.js";

/**
 * Every `Set` method this proxy intercepts, classified so the check below breaks
 * the build if the JS Set surface grows a method we don't handle — the same net
 * that caught the Uint8Array base64 methods. `size` (a getter), `assign` (a
 * Plexus bulk-write), and the materialization symbol aren't Set methods, so they
 * sit outside this inventory.
 */
const SET_METHODS = {
  /** Mutate the set → adopt/orphan + sync. */
  mutating: ["add", "clear", "delete"],
  /** Read-only — forwarded to the live backing set (new sets / booleans / iterators). */
  readonly: [
    "has",
    "forEach",
    "entries",
    "keys",
    "values",
    "union",
    "intersection",
    "difference",
    "symmetricDifference",
    "isSubsetOf",
    "isSupersetOf",
    "isDisjointFrom",
    Symbol.iterator,
  ],
} as const satisfies Record<string, ReadonlyArray<MethodsOf<Set<AllowedYJSValue>>>>;

// Compile error if a Set method is left unclassified — keeps the switch honest as
// the language adds Set operations.
type _SetMethodsExhaustive = AssertNever<
  Exclude<MethodsOf<Set<AllowedYJSValue>>, (typeof SET_METHODS)[keyof typeof SET_METHODS][number]>
>;

// Runtime dispatch tables, derived from the classification so the proxy's routing
// and the exhaustiveness guard share one source and can't drift.
const SET_MUTATING = new Set<PropertyKey>(SET_METHODS.mutating);
const SET_READONLY = new Set<PropertyKey>(SET_METHODS.readonly);

export type MaterializedSetProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildSetProxy = <T extends AllowedYJSKeyValue>({
  owner,
  key,
  isChildField,
}: MaterializedSetProxyInitTarget) => {
  const backingSet = new Set<T>();
  // Serialized key → deserialized element (for observer sync)
  const serializedToElement = new Map<string, T>();

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

  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const yjsMap = getYjsMap();
    if (event.target !== yjsMap || !yjsMap?.doc) return;
    if (telemetry.enabled) {
      telemetry.histogram("plexus.collection.observer_diff_size", event.keysChanged.size, {
        collection_kind: "set",
        is_child_field: isChildField ? "true" : "false",
        new_length_bucket: bucketCount(yjsMap.size),
      });
      if (event.keysChanged.size === 0) {
        telemetry.counter("plexus.collection.observer_no_effect", { collection_kind: "set" });
      }
    }

    for (const serializedKey of event.keysChanged) {
      const hasKeyNow = yjsMap.has(serializedKey);
      if (hasKeyNow) {
        // Added
        const element = deserializeKey(serializedKey, yjsMap.doc) as T;
        backingSet.add(element);
        serializedToElement.set(serializedKey, element);
      } else {
        // Deleted
        const element = serializedToElement.get(serializedKey);
        if (element !== undefined) {
          backingSet.delete(element);
          serializedToElement.delete(serializedKey);
        }
      }
    }
    trackModification(self, KEYS_SYMBOL);
    trackModification(self, ENTRIES_LENGTH_SYMBOL);
  };

  // Initialize from existing Y.Map
  {
    const map = getYjsMap();
    if (map?.doc) {
      attachObserver(map);
      for (const [serializedKey, v] of map.entries()) {
        const element = deserializeKey(serializedKey, map.doc!) as T;
        backingSet.add(element);
        serializedToElement.set(serializedKey, element);
      }
    }
  }

  const self = new Proxy(Object.seal(backingSet), {
    get(_, elementKey) {
      // Read-only Set methods (SET_METHODS.readonly): a uniform read-through to the
      // backing set, gated by the classification so dispatch and the exhaustiveness
      // guard share one source. `has` depends on key membership; the rest read all
      // values.
      if (SET_READONLY.has(elementKey)) {
        return (...args: unknown[]) => {
          trackAccess(owner, key);
          trackAccess(self, elementKey === "has" ? KEYS_SYMBOL : ACCESS_ALL_SYMBOL);
          return (backingSet as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>)[elementKey](...args);
        };
      }
      // Mutating Set methods (SET_METHODS.mutating): bespoke adopt/orphan + sync.
      if (SET_MUTATING.has(elementKey)) {
        if (elementKey === "add") {
          return (value: T) => {
            if (backingSet.has(value)) return false;

            const writeYjs = () => {
              const yjsMap = getYjsMap();
              if (yjsMap && owner.__doc__) {
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.set(sk, value);
                yjsMap.set(sk, maybeReference(value, owner.__doc__!));
              }
            };
            emitOrDefer(owner.__doc__, {
              // Non-atomic path: exactly the original choreography, verbatim.
              applyNow: () => {
                // Adoption materializes the child onto the owner's doc and writes
                // the parent edge (see PlexusModel.informAdoption) — real yjs writes.
                if (isChildField) {
                  value?.[requestAdoptionSymbol]?.(owner, key);
                }
                backingSet.add(value);
                ensureYjsMap();
                maybeTransacting(owner.__doc__!, () => {
                  trackModification(self, KEYS_SYMBOL);
                  trackModification(self, ENTRIES_LENGTH_SYMBOL);
                  writeYjs();
                });
              },
              overlay: () => {
                // Fail-fast on illegal adoption (cycle, cross-doc, self) BEFORE any
                // state change — pure check, no yjs write. Materialization is deferred
                // to `materialize` (phase 1); the parent-edge write to `commit` (phase
                // 2). Optional-chained on the symbol (not `instanceof`) to match the
                // original choreography and avoid a runtime dependency on the type-only
                // PlexusModel import.
                if (isChildField) {
                  value?.[validateAdoptionSymbol]?.(owner, key);
                }
                backingSet.add(value);
              },
              materialize: () => {
                // Phase 1 — GENESIS of the CHILD entity, run OUTSIDE the flush
                // transaction so its materialization keeps its own origin (via
                // `[referenceSymbol]`'s own `maybeTransacting`) instead of being
                // swallowed into the user's tx — the bug this rework exists to fix.
                // This is the same call `informAdoption` makes at PlexusModel.ts:414-415;
                // running it here means the phase-2 `requestAdoption` finds the child
                // already materialized (yjsModel set) and only writes the parent edge.
                // NOTE: the OWNER's field-map materialization (`ensureYjsMap`) is NOT
                // genesis of a new entity — it is part of the user's own edit, so it
                // stays in `commit` and rides the user transaction.
                if (isChildField) {
                  value?.[referenceSymbol]?.(owner.__doc__!);
                }
              },
              commit: () => {
                // Phase 2 — the child is already materialized (phase 1), so this only
                // creates the owner's field map, writes the parent edge, and the field
                // entry, all inside the single flush transaction.
                ensureYjsMap();
                if (isChildField) {
                  value?.[requestAdoptionSymbol]?.(owner, key);
                }
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
                writeYjs();
              },
              revertOverlay: () => {
                // Materialization + adoption were deferred (phases 1/2) and never ran on
                // a rollback, so the child was neither materialized nor adopted — just
                // undo the overlay add. Silent: the overlay `add` fired no
                // `trackModification` (deferred to `commit`), so no observer saw it;
                // undoing it must be silent too, or we'd fire a spurious re-run for a
                // net-zero change.
                backingSet.delete(value);
              },
            });
            return true;
          };
        }
        if (elementKey === "clear") {
          return () => {
            if (backingSet.size === 0) return;
            maybeTransacting(owner.__doc__!, () => {
              if (isChildField) {
                for (const item of backingSet) {
                  item?.[informOrphanizationSymbol]?.();
                }
              }
              backingSet.clear();
              serializedToElement.clear();
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
              getYjsMap()?.clear();
            });
          };
        }
        if (elementKey === "delete") {
          return (value: T) => {
            if (!backingSet.delete(value)) return false;

            if (isChildField) {
              value?.[informOrphanizationSymbol]?.();
            }

            maybeTransacting(owner.__doc__, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
              if (owner.__doc__) {
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.delete(sk);
                getYjsMap()?.delete(sk);
              }
            });
            return true;
          };
        }
      }
      // Structural reads + Plexus-custom bulk ops (not Set.prototype methods).
      switch (elementKey) {
        case "size":
          trackAccess(owner, key);
          trackAccess(self, ENTRIES_LENGTH_SYMBOL);
          return backingSet.size;
        case "assign":
          return (newValues: Iterable<T>) => {
            const newValuesSet = new Set(newValues);
            if (newValuesSet.size > 0) ensureYjsMap();
            const yjsMap = getYjsMap();
            maybeTransacting(owner.__doc__, () => {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);

              if (isChildField) {
                // Validate all new adoptions first
                for (const value of newValuesSet) {
                  if (value && !backingSet.has(value)) {
                    value[validateAdoptionSymbol]?.(owner, key);
                  }
                }
                // Orphan removed values
                for (const item of backingSet) {
                  if (item && !newValuesSet.has(item)) {
                    item[informOrphanizationSymbol]?.();
                  }
                }
              }

              // Clear Y.Map
              yjsMap?.clear();
              backingSet.clear();
              serializedToElement.clear();

              // Adopt new values
              if (isChildField) {
                for (const value of newValuesSet) {
                  if (value && !backingSet.has(value)) {
                    value[requestAdoptionSymbol]?.(owner, key);
                  }
                }
              }

              // Populate
              for (const value of newValuesSet) {
                backingSet.add(value);
                if (yjsMap && owner.__doc__) {
                  const sk = serializeKey(value, owner.__doc__);
                  serializedToElement.set(sk, value);
                  yjsMap.set(sk, maybeReference(value, owner.__doc__!));
                }
              }
            });
          };
        case Symbol.toStringTag:
          return "Set";
        case materializationSymbol:
          return () => {
            const map = getYjsMap();
            if (!map?.doc) {
              backingSet.clear();
              serializedToElement.clear();
              return;
            }
            // Re-sync from Y.Map
            backingSet.clear();
            serializedToElement.clear();
            for (const [serializedKey] of map.entries()) {
              const element = deserializeKey(serializedKey, map.doc!) as T;
              backingSet.add(element);
              serializedToElement.set(serializedKey, element);
            }
            attachObserver(map);
          };
        default:
          return false;
      }
    },
  });
  return self as Set<T> & ReadonlyField<Set<T>>;
};
