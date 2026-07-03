import type * as Y from "yjs";

import { emitOrDefer, isDeferring, isLiminalDoc, type OwnershipMove, type YjsOp } from "../action-buffer.js";
import { PlexusModel } from "../PlexusModel.js";
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
            if (backingSet.has(value)) {
              // STALE-MEMBERSHIP: mid-region the backing set can be stale — this
              // member may already be staged to another parent even though it's
              // still physically present here. A true reaffirmation must still
              // reach the engine so the LAST statement wins the squash (the
              // engine no-ops a genuine no-change); non-child fields (or a
              // non-PlexusModel value) have no ownership to reassert, so they
              // keep the original no-op return.
              // Gated on a deferring receiver (mirroring record.set): on the
              // instant path there is no squash to win, so the plain no-op
              // return stands.
              if (!isChildField || !(value instanceof PlexusModel)) return false;
              if (isDeferring() && owner.__doc__ && !isLiminalDoc(owner.__doc__)) {
                emitOrDefer(owner.__doc__, {
                  applyNow: () => false,
                  overlay: () => {},
                  describe: () => [],
                  notify: () => {},
                  revertOverlay: () => {},
                  moves: [{ child: value, parent: owner, field: key }],
                });
              }
              return false;
            }

            const writeYjs = () => {
              const yjsMap = getYjsMap();
              if (yjsMap && owner.__doc__) {
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.set(sk, value);
                yjsMap.set(sk, maybeReference(value, owner.__doc__!));
              }
            };
            const stagedMoves: OwnershipMove[] =
              isChildField && value instanceof PlexusModel ? [{ child: value, parent: owner, field: key }] : [];
            emitOrDefer(owner.__doc__, {
              // Non-action path: exactly the original choreography, verbatim.
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
                // to `materialize` (phase 1); the parent edge settles once at flush
                // via the staged `moves` (ownership pass). Optional-chained on the
                // symbol (not `instanceof`) to match the original choreography and
                // avoid a runtime dependency on the type-only PlexusModel import.
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
                // This is the same call `informAdoption` (PlexusModel.ts) makes
                // before writing the parent edge; running it here means the flush
                // ownership pass (`settleAdoption`) finds the child already
                // materialized (yjsModel set) and only writes the parent edge.
                // NOTE: the OWNER's field-map materialization (`ensureYjsMap`) is NOT
                // genesis of a new entity — it is part of the user's own edit, so it
                // stays in `describe` and rides the flush transaction.
                if (isChildField) {
                  value?.[referenceSymbol]?.(owner.__doc__!);
                }
              },
              describe: () => {
                // Phase 2 — PURE CONTENT: ownership is settled once at flush by
                // the region engine (via `moves`), not choreographed here. Run
                // the field-map genesis, then RETURN the leaf write as a
                // `map-set` op for the engine to apply through `applyYjsOp`.
                ensureYjsMap();
                const yjsMap = getYjsMap();
                if (!yjsMap || !owner.__doc__) return [];
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.set(sk, value);
                return [{ kind: "map-set", map: yjsMap, key: sk, value: maybeReference(value, owner.__doc__) }];
              },
              notify: () => {
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
              },
              revertOverlay: () => {
                // Materialization + adoption were deferred (phases 1/2) and never ran on
                // a rollback, so the child was neither materialized nor adopted — just
                // undo the overlay add. Silent: the overlay `add` fired no
                // `trackModification` (deferred to `notify`), so no observer saw it;
                // undoing it must be silent too, or we'd fire a spurious re-run for a
                // net-zero change.
                backingSet.delete(value);
              },
              moves: stagedMoves,
            });
            return true;
          };
        }
        if (elementKey === "clear") {
          return () => {
            if (backingSet.size === 0) return;

            // Snapshot the pre-clear contents — overlay empties both collections
            // immediately; the orphan `moves` below are built from the snapshot,
            // and `revertOverlay` (running later, on rollback) restores the mirror.
            const previousItems = isDeferring() ? Array.from(backingSet) : undefined;
            const previousSerialized = isDeferring() ? new Map(serializedToElement) : undefined;

            emitOrDefer(owner.__doc__, {
              // Non-action path: the original choreography — verbatim modulo the
              // residence guard, which is vacuous eagerly (a resident occupant
              // always passes) and only bites when a flush-time sweep re-enters
              // this proxy.
              applyNow: () => {
                maybeTransacting(owner.__doc__!, () => {
                  if (isChildField) {
                    // Orphanize only items that actually RESIDE here — a
                    // flush-time residue sweep re-enters this proxy for a
                    // content-only removal while the child's pointers already
                    // name another home (or none).
                    for (const item of backingSet) {
                      if (item instanceof PlexusModel && item.parent === owner && item.parentField === key) {
                        item[informOrphanizationSymbol]?.();
                      }
                    }
                  }
                  backingSet.clear();
                  serializedToElement.clear();
                  trackModification(self, KEYS_SYMBOL);
                  trackModification(self, ENTRIES_LENGTH_SYMBOL);
                  getYjsMap()?.clear();
                });
              },
              overlay: () => {
                // Local-mirror only — no yjs, no trackModification.
                backingSet.clear();
                serializedToElement.clear();
              },
              describe: () => {
                // PURE CONTENT — ownership (orphanizing every prior member) is
                // settled once at flush by the region engine via `moves`.
                const yjsMap = getYjsMap();
                if (!yjsMap) return [];
                return [{ kind: "map-clear", map: yjsMap }];
              },
              notify: () => {
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
              },
              revertOverlay: () => {
                // Silent — overlay fired no trackModification, so undoing it must not either.
                if (!previousItems || !previousSerialized) return;
                for (const item of previousItems) backingSet.add(item);
                for (const [sk, el] of previousSerialized) serializedToElement.set(sk, el);
              },
              moves: isChildField && previousItems
                ? previousItems
                    .filter((item): item is T & PlexusModel => item instanceof PlexusModel)
                    .map((child) => ({ child, orphan: true as const, from: { parent: owner, field: key } }))
                : undefined,
            });
          };
        }
        if (elementKey === "delete") {
          return (value: T) => {
            // Non-mutating equivalent of the original `!backingSet.delete(value)`
            // guard — the mutation itself moves into applyNow/overlay below.
            if (!backingSet.has(value)) return false;

            emitOrDefer(owner.__doc__, {
              // Non-action path: the original choreography — verbatim minus the
              // has-guard (now run before emitOrDefer) and modulo the residence
              // guard, which is vacuous eagerly (a resident occupant always
              // passes) and only bites when a flush-time sweep re-enters this
              // proxy.
              applyNow: () => {
                backingSet.delete(value);

                // Orphanize only if the child actually RESIDES here — a
                // flush-time residue sweep re-enters this proxy for a
                // content-only removal while the child's pointers already
                // name another home (or none).
                if (isChildField && value instanceof PlexusModel && value.parent === owner && value.parentField === key) {
                  value[informOrphanizationSymbol]?.();
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
              },
              overlay: () => {
                // Local-mirror only — no yjs, no trackModification.
                backingSet.delete(value);
              },
              describe: () => {
                // PURE CONTENT — ownership (orphanizing this member) is
                // settled once at flush by the region engine via `moves`.
                if (!owner.__doc__) return [];
                const yjsMap = getYjsMap();
                const sk = serializeKey(value, owner.__doc__);
                serializedToElement.delete(sk);
                if (!yjsMap) return [];
                return [{ kind: "map-delete", map: yjsMap, key: sk }];
              },
              notify: () => {
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
              },
              revertOverlay: () => {
                // Silent — overlay fired no trackModification, so undoing it must not either.
                backingSet.add(value);
              },
              moves:
                isChildField && value instanceof PlexusModel
                  ? [{ child: value, orphan: true as const, from: { parent: owner, field: key } }]
                  : undefined,
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
            // Snapshot the pre-assign state — overlay mutates `backingSet`
            // immediately, so everything that must tell new children from kept
            // ones (`overlay`'s validation, phase-1 `materialize`) or restore
            // the mirror on rollback (`revertOverlay`) reads this snapshot; the
            // orphan `moves` below are built from it too.
            const previousBackingSet = isDeferring() ? new Set(backingSet) : undefined;
            const previousSerialized = isDeferring() ? new Map(serializedToElement) : undefined;

            // Ownership FACTS for the squash: EVERY asserted member (kept AND
            // new) declares adopt — a kept member may be staged elsewhere
            // mid-region (stale membership), so the engine must see the LAST
            // statement to no-op a true reaffirmation. Every dropped member
            // declares orphan-with-from.
            let stagedMoves: OwnershipMove[] | undefined;
            if (isChildField && previousBackingSet) {
              stagedMoves = [];
              for (const item of previousBackingSet) {
                if (item instanceof PlexusModel && !newValuesSet.has(item)) {
                  stagedMoves.push({ child: item, orphan: true, from: { parent: owner, field: key } });
                }
              }
              for (const value of newValuesSet) {
                if (value instanceof PlexusModel) stagedMoves.push({ child: value, parent: owner, field: key });
              }
            }

            emitOrDefer(owner.__doc__, {
              // Non-action path: the original choreography — verbatim modulo the
              // residence guard, which is vacuous eagerly (a resident occupant
              // always passes) and only bites when a flush-time sweep re-enters
              // this proxy.
              applyNow: () => {
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
                    // Orphan removed values that actually RESIDE here — a
                    // flush-time residue sweep re-enters this proxy for a
                    // content-only removal while the child's pointers already
                    // name another home (or none).
                    for (const item of backingSet) {
                      if (
                        item instanceof PlexusModel &&
                        !newValuesSet.has(item) &&
                        item.parent === owner &&
                        item.parentField === key
                      ) {
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
              },
              overlay: () => {
                if (!previousBackingSet) return;
                // Fail-fast on illegal adoption for genuinely NEW values (checked
                // against the pre-assign snapshot) BEFORE any state change — pure
                // check, no yjs write. Then sync the local-mirror collection.
                if (isChildField) {
                  for (const value of newValuesSet) {
                    if (value && !previousBackingSet.has(value)) {
                      value[validateAdoptionSymbol]?.(owner, key);
                    }
                  }
                }
                backingSet.clear();
                for (const value of newValuesSet) backingSet.add(value);
              },
              materialize: () => {
                // Phase 1 — genesis for children NEW to this field (kept children
                // are already materialized; re-genesis-ing them would be wrong).
                if (!isChildField || !previousBackingSet) return;
                for (const value of newValuesSet) {
                  if (value && !previousBackingSet.has(value)) {
                    value[referenceSymbol]?.(owner.__doc__!);
                  }
                }
              },
              describe: () => {
                // PURE CONTENT — ownership (orphanizing dropped members,
                // adopting kept + new ones) is settled once at flush by the
                // region engine via `moves`.
                if (newValuesSet.size > 0) ensureYjsMap();
                const yjsMap = getYjsMap();

                serializedToElement.clear();
                if (!yjsMap) return [];

                const ops: YjsOp[] = [{ kind: "map-clear", map: yjsMap }];
                if (owner.__doc__) {
                  for (const value of newValuesSet) {
                    const sk = serializeKey(value, owner.__doc__);
                    serializedToElement.set(sk, value);
                    ops.push({ kind: "map-set", map: yjsMap, key: sk, value: maybeReference(value, owner.__doc__) });
                  }
                }
                return ops;
              },
              notify: () => {
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
              },
              revertOverlay: () => {
                // Silent — overlay fired no trackModification, so undoing it must not either.
                if (!previousBackingSet || !previousSerialized) return;
                backingSet.clear();
                for (const item of previousBackingSet) backingSet.add(item);
                serializedToElement.clear();
                for (const [sk, el] of previousSerialized) serializedToElement.set(sk, el);
              },
              moves: stagedMoves,
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
