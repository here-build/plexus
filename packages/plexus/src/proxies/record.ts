import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { emitOrDefer, isDeferring, isLiminalDoc, type OwnershipMove, type YjsOp } from "../action-buffer.js";
import { deref } from "../deref.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informOrphanizationSymbol,
  materializationSymbol,
  referenceSymbol,
  requestAdoptionSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import { bucketCount, telemetry } from "../telemetry.js";
import { ACCESS_ALL_SYMBOL, ENTRIES_LENGTH_SYMBOL, KEYS_SYMBOL, trackAccess, trackModification } from "../tracking.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeMapForField } from "../virtual-children-genesis.js";

export type MaterializedRecordProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildRecordProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
}: MaterializedRecordProxyInitTarget) => {
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
  const backingStorage: Record<string, T> = {};
  const observer = (event: Y.YMapEvent<AllowedYValue>) => {
    const yjsMap = getYjsMap();
    if (event.target !== yjsMap) {
      return;
    }
    if (telemetry.enabled) {
      telemetry.histogram("plexus.collection.observer_diff_size", event.keysChanged.size, {
        collection_kind: "record",
        is_child_field: isChildField ? "true" : "false",
        new_length_bucket: bucketCount(yjsMap.size),
      });
      if (event.keysChanged.size === 0) {
        telemetry.counter("plexus.collection.observer_no_effect", { collection_kind: "record" });
      }
    }
    let structureChanged = false;
    for (const key of event.keysChanged) {
      const hadKeyBefore = key in backingStorage;
      const hasKeyNow = yjsMap.has(key);

      if (hasKeyNow) {
        invariant(
          yjsMap.doc,
          `Plexus<${owner.__type__}#${owner.uuid}.${key}>: observer triggered for Y.Map without doc`,
        );
        backingStorage[key] = deref(yjsMap.doc!, yjsMap.get(key)!) as T;
        if (!hadKeyBefore) structureChanged = true;
      } else {
        delete backingStorage[key];
        if (hadKeyBefore) structureChanged = true;
      }
      trackModification(self, key);
    }
    if (structureChanged) {
      trackModification(self, KEYS_SYMBOL);
      trackModification(self, ENTRIES_LENGTH_SYMBOL);
    }
  };
  {
    const map = getYjsMap();
    if (map) {
      attachObserver(map);
      Object.assign(backingStorage, map.toJSON());
    }
  }
  // We still need to track proxy target state even when we're materialized as it's important for property descriptors.
  // We cannot do dynamic proxy for them so we have to control it directly. Some decisions will look weird without that fact.
  const self = new Proxy(backingStorage, {
    get(proxyTarget, elementKey) {
      switch (elementKey) {
        case "clear":
          return () => {
            if (Object.keys(proxyTarget).length === 0) {
              return;
            }
            // Snapshot taken at statement time, before the overlay empties
            // `proxyTarget` — it feeds the ownership moves right below and the
            // (silent) overlay inverse in `revertOverlay`.
            const previousEntries = { ...proxyTarget };
            const stagedMoves: OwnershipMove[] = isChildField
              ? Object.entries(previousEntries)
                  .filter((entry): entry is [string, T & PlexusModel] => entry[1] instanceof PlexusModel)
                  .map(([k, child]) => ({ child, orphan: true as const, from: { parent: owner, field: key, meta: k } }))
              : [];
            emitOrDefer(owner.__doc__, {
              // Non-action path: the original choreography — verbatim modulo the
              // residence guards, which are vacuous eagerly (a resident occupant
              // always passes) and only bite when flush-time sweeps re-enter
              // this proxy.
              applyNow: () => {
                // Clear parent tracking for all child values that still RESIDE
                // here (flush-time sweeps re-enter this proxy for content-only
                // removals).
                if (isChildField) {
                  for (const value of Object.values(proxyTarget)) {
                    if (value instanceof PlexusModel && value.parent === owner && value.parentField === key) {
                      value[informOrphanizationSymbol]?.();
                    }
                  }
                }

                for (const key of Object.keys(proxyTarget)) {
                  delete proxyTarget[key];
                }
                getYjsMap()?.clear();
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              overlay: () => {
                for (const k of Object.keys(proxyTarget)) {
                  delete proxyTarget[k];
                }
              },
              describe: () => {
                const yjsMap = getYjsMap();
                if (!yjsMap) return [];
                return [{ kind: "map-clear", map: yjsMap }];
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                // Silent restore — the overlay's clear fired no `trackModification`.
                Object.assign(proxyTarget, previousEntries);
              },
              moves: stagedMoves,
            });
          };
        case "assign":
          return (newEntries: Record<string, AllowedYJSValue> | Iterable<[string, AllowedYJSValue]>) => {
            // Snapshot ONCE, shared by every branch below — `newEntries` may be a
            // one-shot iterable (generator, map.entries()), so it must be consumed
            // exactly once.
            const entriesArray: [string, AllowedYJSValue][] = [
              ...(Symbol.iterator in newEntries ? newEntries : Object.entries(newEntries)),
            ];
            const oldValueSet = new Set(Object.values(proxyTarget));
            const newValueSet = new Set(entriesArray.map(([_, v]) => v));
            const previousEntries = { ...proxyTarget };
            // STALE-MEMBERSHIP RULE (assign-like full replacement): every model
            // value KEPT IN the new entries declares adopt (even if unchanged —
            // it may be staged to another parent this region; the engine's
            // stageMoves no-ops a true reaffirmation against EFFECTIVE
            // ownership). Every removed model value declares orphan-with-from.
            // A value moving between keys within this record falls out
            // naturally: only its LAST adopt (its final entry) survives the
            // per-child squash.
            const stagedMoves: OwnershipMove[] = isChildField
              ? [
                  ...Object.entries(previousEntries)
                    .filter(
                      (entry): entry is [string, T & PlexusModel] =>
                        entry[1] instanceof PlexusModel && !newValueSet.has(entry[1]),
                    )
                    .map(([k, child]) => ({ child, orphan: true as const, from: { parent: owner, field: key, meta: k } })),
                  ...entriesArray
                    .filter((entry): entry is [string, T & PlexusModel] => entry[1] instanceof PlexusModel)
                    .map(([k, child]) => ({ child, parent: owner, field: key, meta: k })),
                ]
              : [];

            emitOrDefer(owner.__doc__, {
              // Non-action path: the original choreography over the shared snapshot.
              applyNow: () => {
                ensureYjsMap(); // create container outside tracked transaction
                maybeTransacting(owner.__doc__, () => {
                  // For child fields, VALIDATE all adoptions BEFORE any state changes
                  if (isChildField) {
                    // VALIDATE FIRST: Check all truly new values can be adopted
                    for (const [k, v] of entriesArray) {
                      if (v && !oldValueSet.has(v as any)) {
                        v[validateAdoptionSymbol]?.(owner, key, k);
                      }
                    }

                    // Now safe to orphan values that aren't in the new set and
                    // still RESIDE here (flush-time sweeps re-enter this proxy
                    // for content-only removals).
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

                  for (const k of Object.keys(proxyTarget)) {
                    delete proxyTarget[k];
                  }
                  Object.assign(proxyTarget, Object.fromEntries(entriesArray));

                  const map = getYjsMap();
                  map?.clear();

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  for (const [k, v] of entriesArray) {
                    // Adopt truly new values
                    if (isChildField && v && !oldValueSet.has(v as any)) {
                      v[requestAdoptionSymbol]?.(owner, key, k);
                    }
                    map?.set(k, maybeReference(v, owner.__doc__!));
                  }
                });
              },
              overlay: () => {
                // Fail-fast on illegal adoptions for truly-new values BEFORE any
                // state change — pure check, no yjs write. Genesis is deferred to
                // `materialize`; ownership choreography moves to `moves`; the
                // leaf writes to `describe`.
                if (isChildField) {
                  for (const [k, v] of entriesArray) {
                    if (v && !oldValueSet.has(v as any)) {
                      v[validateAdoptionSymbol]?.(owner, key, k);
                    }
                  }
                }
                for (const k of Object.keys(proxyTarget)) {
                  delete proxyTarget[k];
                }
                Object.assign(proxyTarget, Object.fromEntries(entriesArray));
              },
              materialize: () => {
                // Phase 1 — genesis of each truly-new child, outside the flush tx.
                if (isChildField) {
                  for (const [, v] of entriesArray) {
                    if (v && !oldValueSet.has(v as any)) {
                      v[referenceSymbol]?.(owner.__doc__!);
                    }
                  }
                }
              },
              describe: () => {
                ensureYjsMap();
                const map = getYjsMap();
                if (!map) return [];
                const ops: YjsOp[] = [{ kind: "map-clear", map }];
                for (const [k, v] of entriesArray) {
                  ops.push({ kind: "map-set", map, key: k, value: maybeReference(v, owner.__doc__!) });
                }
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                // Silent restore — the overlay fired no `trackModification`.
                for (const k of Object.keys(proxyTarget)) {
                  delete proxyTarget[k];
                }
                Object.assign(proxyTarget, previousEntries);
              },
              moves: stagedMoves,
            });
          };
        case materializationSymbol:
          return () => {
            const map = getYjsMap();
            if (!map) {
              // Container absent or removed (e.g., by undo) — clear the proxy
              for (const k of Object.keys(backingStorage)) {
                delete backingStorage[k];
              }
              return;
            }
            Object.assign(
              backingStorage,
              Object.fromEntries(Object.entries(map.toJSON()).map(([key, value]) => [key, deref(map.doc!, value)])),
            );
            attachObserver(map);
          };
      }

      // Well-known Symbol support for record/map - intentionally preserved as switch to represent flat routing
      if (typeof elementKey === "symbol") {
        // eslint-disable-next-line sonarjs/no-small-switch
        switch (elementKey) {
          case Symbol.toStringTag:
            return "Object";
        }
      }

      if (elementKey in Object.prototype) {
        // Accessing Object prototype methods. Todo make more precise
        if (typeof Object.prototype[elementKey] === "function") {
          return function (this: any, ...args) {
            if (this === self) {
              trackAccess(owner, key);
              trackAccess(self, ACCESS_ALL_SYMBOL);
            }
            return Object.prototype[elementKey].apply(self, args);
          };
        } else {
          trackAccess(owner, key);
          trackAccess(self, ACCESS_ALL_SYMBOL);
          return Object.prototype[elementKey];
        }
      } else if (typeof elementKey === "string") {
        // Specific field access
        trackAccess(owner, key);
        trackAccess(self, elementKey);
        // we intentionally treat undefined as null for smaller yjs doc size and consistency
        // (as we do not differentiate missing field and empty field anywhere but in `has`)
        return proxyTarget[elementKey];
      }
    },
    set(proxyTarget, elementKey, value) {
      if (typeof elementKey === "string") {
        const hadKeyBefore = elementKey in proxyTarget;
        const previousValue = proxyTarget[elementKey];
        // Track key changes: key added (wasn't present, now has value) or removed (was present, now undefined)
        const structureChanged = (hadKeyBefore && value === undefined) || (!hadKeyBefore && value !== undefined);

        // STALE-MEMBERSHIP RULE (deferring receivers only): mid-region the
        // backing record is stale — a true reaffirmation (backing already
        // holds `value` at this key) must still declare its adopt move,
        // because `value` may be staged to another parent this region. For a
        // non-child field, this is a real no-op: emit nothing. For a child
        // field, emit a moves-only statement — overlay/describe/notify/
        // revertOverlay are all no-ops, and the engine itself gates true
        // reaffirmations against EFFECTIVE ownership (stageMoves), so a
        // genuinely-unstaged value costs nothing. Everywhere the write
        // settles instantly — outside a region, or mid-region on a receiver
        // that does NOT defer (doc-less or liminal doc, mirroring
        // emitOrDefer's routing) — this fast path must not exist: the
        // original choreography re-ran the full write on a same-value set
        // (modification tracking, transient orphan/re-adopt churn), and
        // instant paths stay byte-for-byte original — so we fall through.
        if (hadKeyBefore && previousValue === value && isDeferring() && owner.__doc__ && !isLiminalDoc(owner.__doc__)) {
          if (!isChildField) return true;
          emitOrDefer(owner.__doc__, {
            applyNow: () => {
              // Unreachable: this statement is emitted only when the receiver
              // defers (per-doc gate above), so emitOrDefer always takes the
              // buffered branch. The arm exists for the EmitOps shape.
            },
            overlay: () => {},
            describe: () => [],
            notify: () => {},
            revertOverlay: () => {},
            moves:
              value instanceof PlexusModel
                ? [{ child: value, parent: owner, field: key, meta: elementKey }]
                : undefined,
          });
          return true;
        }

        emitOrDefer(owner.__doc__, {
          // Non-action path: the original choreography — verbatim modulo the
          // residence guard, which is vacuous eagerly (a resident occupant
          // always passes) and only bites when flush-time sweeps re-enter
          // this proxy.
          applyNow: () => {
            if (value !== undefined) ensureYjsMap();
            maybeTransacting(owner.__doc__, () => {
              trackModification(self, elementKey);
              // Track key changes: key added (wasn't present, now has value) or removed (was present, now undefined)
              if (
                (elementKey in proxyTarget && value === undefined) ||
                (!(elementKey in proxyTarget) && value !== undefined)
              ) {
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
              }
              if (isChildField) {
                // VALIDATE FIRST before any state changes (throws on cycle)
                value?.[validateAdoptionSymbol]?.(owner, key, elementKey);
                // Now safe to orphan old value (only if it still RESIDES here —
                // flush-time sweeps re-enter this proxy for content-only
                // removals) and adopt new one
                const oldItem = proxyTarget[elementKey];
                if (
                  oldItem instanceof PlexusModel &&
                  oldItem.parent === owner &&
                  oldItem.parentField === key
                ) {
                  oldItem[requestOrphanizationSymbol]?.();
                }
                value?.[requestAdoptionSymbol]?.(owner, key, elementKey);
              }
              // undefined = delete key, null = explicit "nothing" value
              if (value === undefined) {
                delete proxyTarget[elementKey];
              } else {
                proxyTarget[elementKey] = value;
              }
              if (value === undefined) {
                getYjsMap()?.delete(elementKey);
              } else {
                getYjsMap()?.set(elementKey, maybeReference(value, owner.__doc__!));
              }
            });
          },
          overlay: () => {
            // Fail-fast on illegal adoption BEFORE any state change — pure check,
            // no yjs write. Genesis is deferred to `materialize`; ownership
            // choreography moves to `moves`; the leaf write to `describe`.
            if (isChildField) {
              value?.[validateAdoptionSymbol]?.(owner, key, elementKey);
            }
            // undefined = delete key, null = explicit "nothing" value
            if (value === undefined) {
              delete proxyTarget[elementKey];
            } else {
              proxyTarget[elementKey] = value;
            }
          },
          materialize: () => {
            // Phase 1 — genesis of the CHILD entity being inserted, outside the flush tx.
            if (isChildField) {
              value?.[referenceSymbol]?.(owner.__doc__!);
            }
          },
          describe: () => {
            if (value !== undefined) ensureYjsMap();
            const yjsMap = getYjsMap();
            if (!yjsMap) return [];
            return value === undefined
              ? [{ kind: "map-delete", map: yjsMap, key: elementKey }]
              : [{ kind: "map-set", map: yjsMap, key: elementKey, value: maybeReference(value, owner.__doc__!) }];
          },
          notify: () => {
            trackModification(self, elementKey);
            if (structureChanged) {
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
            }
          },
          revertOverlay: () => {
            // Silent restore — the overlay fired no `trackModification`.
            if (hadKeyBefore) {
              proxyTarget[elementKey] = previousValue;
            } else {
              delete proxyTarget[elementKey];
            }
          },
          moves: isChildField
            ? [
                ...(previousValue instanceof PlexusModel && previousValue !== value
                  ? [{ child: previousValue, orphan: true as const, from: { parent: owner, field: key, meta: elementKey } }]
                  : []),
                ...(value instanceof PlexusModel ? [{ child: value, parent: owner, field: key, meta: elementKey }] : []),
              ]
            : undefined,
        });
        return true;
      }
      console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
      return false;
    },
    deleteProperty(proxyTarget, elementKey) {
      // noinspection SuspiciousTypeOfGuard
      if (typeof elementKey === "symbol") {
        return true;
      }
      if (!Object.hasOwn(proxyTarget, elementKey)) {
        return true;
      }

      // Snapshot taken at statement time, before the overlay deletes the key —
      // it feeds the ownership move below and the (silent) overlay inverse in
      // `revertOverlay`.
      const previousValue = proxyTarget[elementKey];
      let overlayDeleted = false;
      emitOrDefer(owner.__doc__, {
        // Non-action path: the original choreography — verbatim modulo the
        // residence guard, which is vacuous eagerly (a resident occupant
        // always passes) and only bites when flush-time sweeps re-enter
        // this proxy.
        applyNow: () => {
          maybeTransacting(owner.__doc__, () => {
            // Handle parent tracking for child fields — only if the value still
            // RESIDES here (flush-time sweeps re-enter this proxy for
            // content-only removals).
            if (isChildField) {
              const oldItem = proxyTarget[elementKey];
              if (oldItem instanceof PlexusModel && oldItem.parent === owner && oldItem.parentField === key) {
                oldItem[informOrphanizationSymbol]?.();
              }
            }
            getYjsMap()?.delete(elementKey);
            if (Reflect.deleteProperty(proxyTarget, elementKey)) {
              trackModification(self, elementKey);
              trackModification(self, KEYS_SYMBOL);
              trackModification(self, ENTRIES_LENGTH_SYMBOL);
            }
          });
        },
        overlay: () => {
          overlayDeleted = Reflect.deleteProperty(proxyTarget, elementKey);
        },
        // No `materialize` — deletes never genesis a child.
        describe: () => {
          const yjsMap = getYjsMap();
          if (!yjsMap) return [];
          return [{ kind: "map-delete", map: yjsMap, key: elementKey }];
        },
        moves:
          isChildField && previousValue instanceof PlexusModel
            ? [{ child: previousValue, orphan: true as const, from: { parent: owner, field: key, meta: elementKey } }]
            : undefined,
        notify: () => {
          // Track only if the delete took — applyNow's Reflect guard, mirrored.
          if (!overlayDeleted) return;
          trackModification(self, elementKey);
          trackModification(self, KEYS_SYMBOL);
          trackModification(self, ENTRIES_LENGTH_SYMBOL);
        },
        revertOverlay: () => {
          // Silent restore — the overlay fired no `trackModification`.
          proxyTarget[elementKey] = previousValue;
        },
      });
      return true;
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(proxyTarget, elementKey) {
      if (typeof elementKey === "symbol") {
        return false;
      }
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      return Reflect.has(proxyTarget, elementKey);
    },
    ownKeys(proxyTarget) {
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      return Reflect.ownKeys(proxyTarget);
    },
  });
  return self as Record<string, T> & ReadonlyField<Record<string, T>>;
};
