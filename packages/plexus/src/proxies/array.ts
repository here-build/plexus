import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { emitOrDefer, type OwnershipMove, type YjsOp } from "../action-buffer.js";
import { deref } from "../deref.js";
import { PlexusDuplicateChildError } from "../errors.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReadonlyField } from "../proxy-runtime-types.js";
import {
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  referenceSymbol,
  requestAdoptionSymbol,
  validateAdoptionSymbol,
} from "../proxy-runtime-types.js";
import { bucketCount, telemetry } from "../telemetry.js";
import {
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  KEYS_SYMBOL,
  trackAccess,
  trackModification,
  VALUES_SYMBOL,
} from "../tracking.js";
import { undoManagerNotifications } from "../utils/undoManagerNotifications.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { materializeArrayForField } from "../virtual-children-genesis.js";
import { type AssertNever, type MethodsOf } from "./method-classification.js";

/**
 * Every `Array` method this proxy intercepts, classified so the check below
 * breaks the build if the JS Array surface grows a method we don't handle — the
 * same net that caught the Uint8Array base64 methods. `length` (a getter),
 * `clear`/`assign` (Plexus bulk-writes), and the materialization symbol aren't
 * Array methods, so they sit outside this inventory.
 */
const ARRAY_METHODS = {
  /** Mutate in place → re-sync the Y.Array. */
  mutating: ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"],
  /** Read-only — forwarded to the live backing array (values / new arrays / iterators). */
  readonly: [
    "at",
    "concat",
    "entries",
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flat",
    "flatMap",
    "forEach",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "slice",
    "some",
    "toLocaleString",
    "toReversed",
    "toSorted",
    "toSpliced",
    "toString",
    "values",
    "with",
    Symbol.iterator,
  ],
} as const satisfies Record<string, ReadonlyArray<MethodsOf<Array<AllowedYJSValue>>>>;

// Compile error if an Array method is left unclassified — keeps the proxy honest
// as the language adds Array operations.
type _ArrayMethodsExhaustive = AssertNever<
  Exclude<MethodsOf<Array<AllowedYJSValue>>, (typeof ARRAY_METHODS)[keyof typeof ARRAY_METHODS][number]>
>;

/** The in-place mutators — derived from the classification above so they can't drift. */
const mutableArrayMethods = new Set<string | symbol>(ARRAY_METHODS.mutating);
/** The read-only methods — likewise derived, so the dispatch reads the classification. */
const arrayReadonlyMethods = new Set<string | symbol>(ARRAY_METHODS.readonly);

// Track if we've shown the copyWithin warning for child arrays (one-time per session)
let copyWithinChildArrayWarningShown = false;

/**
 * Important implementation nuances
 *
 * Plexus is implementing dom-style parent-child ownership management.
 * Child-parent relationship is determined not only by entity, but also by field (and, for maps, subfield).
 * For obvious reasons of dynamic array nature and yjs backend presence, we do not store array keys in parent tuple,
 * but virtually we still follow that convention.
 *
 * Efficiently, this leads to organic implicit constraint of uniqueness-per-child-array.
 *
 * However, this emerges a problem of native array method intents: when array is being restructured with some
 * child being present twice, we're unable to understand the intent we should preserve, as there is no hook like
 * "before element is added".
 *
 * To mitigate it, we explicitly redefine all native mutating methods of Array.prototype to handle the actual intent.
 *
 * Important architectural decision (that may be potentially wrong):
 * if we have multiple entries of same model in addition intent for child-owning array,
 * we consider it an error as we're unable to clarify the intent. e.g.:
 * [a,b,c].push(a) - works fine
 * [a,b,c].push(a, b, a) - crashes, because we have no idea what should be the efficient order - c,b,a or c,a,b
 *
 * This works for all mutating methods that accept multiple elements as input - push, unshift, splice etc.
 *
 * To explain general strategy, specific details on parent-child tracking needs to be explained.
 * Model never controls its own _addition_ but may control its _removal_.
 * Just like in DOM, where you can do item.remove(), but you need to do parent.append(item)
 *
 * In Plexus, there is 4 internal ownership intent symbols for granular control:
 * inform adoption/orphanization intent:
 *  "you do not have parent/this is your parent now. I've done everything already, just adjust your metadata"
 * request adoption/orphanization intent is same as above PLUS remove self from old parent.
 * This is done instead of just emancipation intent symbol, because requestAdoptionSymbol intent needs
 * to conditionally execute informAdoptionSymbol internally.
 * This is general issue with complex ownership tracking systems - we need precision control of what is happening in
 * each phase of actions, and a lot of nuanced behaviors: e.g. requestOrphanizationSymbol when we're cleaning array from
 * old references will cause elements index shift, and we need to keep it in mind.
 *
 * General strategy for each of the methods in child-owning mode relies on a fact that each array mutation is some kind
 * of splice: remove 0.. elements at certain index, then add 0.. elements at same index.
 * General scenario is following (with per-method optimizations):
 * - check duplicates on input; if there are some, throw error
 * - for copyWithin and other index-pointing calls - convert index-pointing arguments to actual values
 *      to stop caring about index drift
 * - remove what is needed. that removals MAY affect insertion pointer if removed entities are before pointer.
 *      this phase should also call y.Array.delete on removals, but some profound optimization strategies are allowed
 *      - if method has removal intent, remove elements according to that intent
 *      - if there are some, remove input items from actual array state and _inform_ them they are orphaned
 *        they are not adopted yet but temporarily orphaned and in "limbo" now, so we will not accidentally remove them,
 *        when we will update the parent after the new addition
 * - put new elements at adjusted index and inform they are adopted now
 *
 * # YJS nuances
 * YJS do not provide "move" intent for array mutations. What it does provide:
 * - .delete(index, length)
 * - .insert(index, item[])
 * - .push(item[]) - push is optimized intent that is not changing searchMarker, so if possible we should use it
 *
 * There is multiple edge cases taken into account.
 * 1. push([a, a]): Throws - input contains duplicates
 * 2. arr = [a, b]; arr[2] = a: Removes 'a' from index 0, sets at index 1 (adjusted), final: [b, a]
 * 3. arr = [a, b, a]; pop(): Returns 'a' but doesn't orphanize (still exists at index 0) - impossible case but handled gracefully
 * 4. arr.copyWithin(0, 2, 4): Throws if would create duplicates like [c, d, c, d]
 * 5. splice(0, 0, a, b, a): Throws - inserting same item multiple times in input
 * 6. arr = [a, b]; splice(1, 0, a): Valid move operation - removes 'a' from index 0, adjusts index, inserts at adjusted position, final: [a, b]
 * 7. reverse/sort: No parent tracking needed - just reorders existing items
 */

// Node/JS engines prior to Set.prototype.difference support
function setDifference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const diff = (a as any).difference;
  if (typeof diff === "function") {
    return diff.call(a, b);
  }
  const res = new Set<T>();
  for (const v of a) if (!b.has(v)) res.add(v);
  return res;
}

export type MaterializedArrayProxyInitTarget = {
  owner: PlexusModel;
  key: string;
  isChildField?: boolean;
};

export const buildArrayProxy = <T extends AllowedYJSValue>({
  owner,
  key,
  isChildField,
}: MaterializedArrayProxyInitTarget) => {
  const backingArray: Array<T | null> = [];
  const getYjsArray = (): Y.Array<AllowedYValue> | null => {
    return (owner.__yjsFieldsMap__?.get(key) as Y.Array<AllowedYValue>) ?? null;
  };

  const attachObserver = (arr: Y.Array<AllowedYValue>) => {
    if (undoManagerNotifications.has(arr)) return;
    arr.observe(observer);
    undoManagerNotifications.set(arr, observer);
  };

  const ensureYjsArray = (): Y.Array<AllowedYValue> | null => {
    const existing = getYjsArray();
    if (existing) return existing;
    if (!owner.__doc__ || !owner.__yjsFieldsMap__) return null;
    const arr = materializeArrayForField(owner, key);
    attachObserver(arr);
    return arr;
  };
  const observer = (event: Y.YArrayEvent<AllowedYValue>) => {
    const yjsArray = getYjsArray();
    if (event.target !== yjsArray) {
      return;
    }
    invariant(
      yjsArray.doc,
      `Plexus<${owner.__type__}#${owner.uuid}.${key}>: observer triggered for Y.Array without doc`,
    );

    const oldLength = backingArray.length;
    const newItems = yjsArray.toArray().map((item) => deref<T>(yjsArray.doc!, item));
    const newLength = newItems.length;

    // Track which indices changed
    const changedIndices: number[] = [];
    const maxLen = Math.max(oldLength, newLength);
    for (let i = 0; i < maxLen; i++) {
      if (backingArray[i] !== newItems[i]) {
        changedIndices.push(i);
      }
    }

    if (telemetry.enabled) {
      // Diff cost surfaces "this proxy's remote-applied diff is the hot
      // spot" — a class of regression invisible from outside the
      // reactive layer. Bucketed so per-emit cardinality is bounded.
      telemetry.histogram("plexus.collection.observer_diff_size", changedIndices.length, {
        collection_kind: "array",
        is_child_field: isChildField ? "true" : "false",
        new_length_bucket: bucketCount(newLength),
      });
      if (changedIndices.length === 0 && oldLength === newLength) {
        // tldraw's "ops-with-no-effect" detector — observer fired but
        // produced zero observable state change. Catches runaway
        // reactive writes (the canonical useEffect-into-Y.Map class).
        telemetry.counter("plexus.collection.observer_no_effect", { collection_kind: "array" });
      }
    }

    // Update backing array
    backingArray.splice(0, backingArray.length, ...newItems);

    // Emit precise notifications
    for (const index of changedIndices) {
      trackModification(self, `${index}`);
    }

    // Emit VALUES_SYMBOL if any values changed
    if (changedIndices.length > 0) {
      trackModification(self, VALUES_SYMBOL);
    }

    // Only emit KEYS_SYMBOL if length actually changed
    if (oldLength !== newLength) {
      trackModification(self, KEYS_SYMBOL);
      trackModification(self, ENTRIES_LENGTH_SYMBOL);
    }
  };
  {
    const yjsArray = getYjsArray();
    if (yjsArray) {
      attachObserver(yjsArray);
    }
  }

  const self = new Proxy(backingArray, {
    get(_, elementKey) {
      // MUTATING ARRAY METHODS: Convert entities to references, sync to YJS
      switch (elementKey) {
        case "push":
          // arr.push(entity) → yArray.push(entity.reference())
          //
          // EDGE CASE HANDLING:
          // 1. Duplicate Prevention: For child fields, the same child cannot appear multiple times
          //    in the same parent array. This maintains parent tracking invariant: one child, one parent position.
          //    Example: push(a, a) throws error to prevent [existing..., a, a]
          //
          // 2. Reuse Detection: If pushing an item that already exists elsewhere in the array,
          //    it is MOVED to the end — the old occurrence is spliced out, then the element
          //    is pushed. Example: arr = [a, b], push(a) → [b, a]. Reused items get
          //    informAdoptionSymbol (their parent pointer already names this owner) instead
          //    of the full requestAdoptionSymbol choreography new items get.
          //
          // 3. Parent Tracking Sequence:
          //    - requestAdoptionSymbol: Called BEFORE push for new items
          //    - informAdoptionSymbol: Called AFTER push for reused items
          //    This ordering ensures parent refs are updated correctly for CRDT synchronization
          //

          return (...elements: Array<T>) => {
            // Classification computed ONCE here (shared by overlay/materialize/describe/notify).
            // applyNow recomputes its own copy internally — it must stay a verbatim,
            // self-contained copy of the pre-action choreography.
            const reusedIndices: number[] = [];
            const reusedElements: T[] = [];
            const newElements: T[] = [];
            const stagedMoves: OwnershipMove[] = [];
            if (isChildField) {
              PlexusDuplicateChildError.uniquenessInvariant(elements, owner, key, "push");
              for (const element of elements) {
                if (element instanceof PlexusModel) {
                  const existingIndex = backingArray.indexOf(element);
                  if (existingIndex === -1) {
                    newElements.push(element);
                    stagedMoves.push({ child: element, parent: owner, field: key });
                  } else {
                    reusedIndices.push(existingIndex);
                    reusedElements.push(element);
                    // Reuse classifies against STALE mid-region membership — the
                    // element may be staged to another parent. Declaring the
                    // adoption keeps the squash on the LAST statement; the engine
                    // gates it to a no-op when it's a true reaffirmation.
                    stagedMoves.push({ child: element, parent: owner, field: key });
                  }
                }
              }
              reusedIndices.sort((a, b) => b - a);
            }
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                ensureYjsArray();
                return maybeTransacting(owner.__doc__, () => {
                  // Update parent tracking for child fields
                  const reusedIndices: number[] = [];
                  const reusedElements: T[] = [];
                  const newElements: T[] = [];
                  if (isChildField) {
                    PlexusDuplicateChildError.uniquenessInvariant(elements, owner, key, "push");

                    for (const element of elements) {
                      if (element instanceof PlexusModel) {
                        const existingIndex = backingArray.indexOf(element);
                        if (existingIndex === -1) {
                          newElements.push(element);
                        } else {
                          reusedIndices.push(existingIndex);
                          reusedElements.push(element);
                        }
                      }
                    }

                    // VALIDATE FIRST: Check all new elements can be adopted before any state changes
                    for (const element of newElements) {
                      element?.[validateAdoptionSymbol]?.(owner, key);
                    }

                    // Now safe to remove reused elements from their old positions (in reverse order)
                    reusedIndices.sort((a, b) => b - a);
                    for (const index of reusedIndices) {
                      backingArray.splice(index, 1);
                    }

                    for (const element of newElements) {
                      element?.[requestAdoptionSymbol]?.(owner, key);
                    }
                  }

                  backingArray.push(...elements);

                  const yjsArray = getYjsArray();
                  if (yjsArray) {
                    for (const index of reusedIndices) {
                      yjsArray.delete(index, 1);
                    }
                    yjsArray.push(elements.map((element) => maybeReference(element, owner.__doc__!)));
                  }

                  if (isChildField) {
                    for (const element of reusedElements) {
                      element?.[informAdoptionSymbol](owner, key);
                    }
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return backingArray.length;
                });
              },
              overlay: () => {
                if (isChildField) {
                  for (const element of newElements) {
                    element?.[validateAdoptionSymbol]?.(owner, key);
                  }
                  for (const index of reusedIndices) {
                    backingArray.splice(index, 1);
                  }
                }
                backingArray.push(...elements);
              },
              materialize: () => {
                if (isChildField) {
                  for (const element of newElements) {
                    element?.[referenceSymbol]?.(owner.__doc__!);
                  }
                }
              },
              describe: () => {
                ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                for (const index of reusedIndices) {
                  ops.push({ kind: "array-delete", array: yjsArray, index, length: 1 });
                }
                ops.push({
                  kind: "array-insert",
                  array: yjsArray,
                  index: yjsArray.length - reusedIndices.length,
                  content: elements.map((element) => maybeReference(element, owner.__doc__!)),
                });
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
              moves: stagedMoves,
            });
            return backingArray.length;
          };
        case "unshift": // arr.unshift(entity) → yArray.unshift(entity.reference())
          return (...elements: Array<T>) => {
            // Classification computed ONCE here (shared by overlay/materialize/describe/notify).
            const reusedIndices: number[] = [];
            const reusedElements: T[] = [];
            const newElements: T[] = [];
            const stagedMoves: OwnershipMove[] = [];
            if (isChildField) {
              PlexusDuplicateChildError.uniquenessInvariant(elements, owner, key, "unshift");
              for (const element of elements) {
                if (element instanceof PlexusModel) {
                  const existingIndex = backingArray.indexOf(element);
                  if (existingIndex === -1) {
                    newElements.push(element);
                    stagedMoves.push({ child: element, parent: owner, field: key });
                  } else {
                    reusedIndices.push(existingIndex);
                    reusedElements.push(element);
                    // Reuse classifies against STALE mid-region membership (see push).
                    stagedMoves.push({ child: element, parent: owner, field: key });
                  }
                }
              }
              reusedIndices.sort((a, b) => b - a);
            }
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                ensureYjsArray();
                return maybeTransacting(owner.__doc__, () => {
                  // Update parent tracking for child fields
                  const reusedIndices: number[] = [];
                  const reusedElements: T[] = [];
                  const newElements: T[] = [];
                  if (isChildField) {
                    PlexusDuplicateChildError.uniquenessInvariant(elements, owner, key, "unshift");

                    for (const element of elements) {
                      if (element instanceof PlexusModel) {
                        const existingIndex = backingArray.indexOf(element);
                        if (existingIndex === -1) {
                          newElements.push(element);
                        } else {
                          reusedIndices.push(existingIndex);
                          reusedElements.push(element);
                        }
                      }
                    }

                    // VALIDATE FIRST: Check all new elements can be adopted before any state changes
                    for (const element of newElements) {
                      element?.[validateAdoptionSymbol]?.(owner, key);
                    }

                    // Now safe to remove reused elements from their old positions
                    reusedIndices.sort((a, b) => b - a);
                    for (const index of reusedIndices) {
                      backingArray.splice(index, 1);
                    }

                    for (const element of newElements) {
                      element?.[requestAdoptionSymbol]?.(owner, key);
                    }
                  }

                  backingArray.unshift(...elements);

                  if (isChildField) {
                    for (const element of reusedElements) {
                      element?.[informAdoptionSymbol](owner, key);
                    }
                  }

                  const yjsArray = getYjsArray();
                  if (yjsArray) {
                    for (const index of reusedIndices) {
                      yjsArray.delete(index, 1);
                    }
                  }
                  yjsArray?.unshift(elements.map((element) => maybeReference(element, owner.__doc__!)));

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return backingArray.length;
                });
              },
              overlay: () => {
                if (isChildField) {
                  for (const element of newElements) {
                    element?.[validateAdoptionSymbol]?.(owner, key);
                  }
                  for (const index of reusedIndices) {
                    backingArray.splice(index, 1);
                  }
                }
                backingArray.unshift(...elements);
              },
              materialize: () => {
                if (isChildField) {
                  for (const element of newElements) {
                    element?.[referenceSymbol]?.(owner.__doc__!);
                  }
                }
              },
              describe: () => {
                ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                for (const index of reusedIndices) {
                  ops.push({ kind: "array-delete", array: yjsArray, index, length: 1 });
                }
                ops.push({
                  kind: "array-insert",
                  array: yjsArray,
                  index: 0,
                  content: elements.map((element) => maybeReference(element, owner.__doc__!)),
                });
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
              moves: stagedMoves,
            });
            return backingArray.length;
          };
        case "splice": // arr.splice(index, deleteCount, ...items)
          return (start: number, deleteCount?: number, ...itemsToInsert: Array<T>) => {
            const actualStart =
              start < 0 ? Math.max(backingArray.length + start, 0) : Math.min(start, backingArray.length);
            const actualDeleteCount =
              deleteCount === undefined
                ? backingArray.length - actualStart
                : Math.max(0, Math.min(deleteCount, backingArray.length - actualStart));
            const removedItems = backingArray.slice(actualStart, actualStart + actualDeleteCount);
            if (isChildField && itemsToInsert.length > 0) {
              PlexusDuplicateChildError.uniquenessInvariant(itemsToInsert, owner, key, "splice");
            }
            const itemsToRemoveFirst: Array<{ item: T; index: number }> = [];
            const trulyNewItems: T[] = [];
            for (const item of itemsToInsert) {
              const existingIndex = backingArray.indexOf(item);
              if (
                existingIndex !== -1 &&
                (existingIndex < actualStart || existingIndex >= actualStart + actualDeleteCount)
              ) {
                itemsToRemoveFirst.push({ item, index: existingIndex });
              } else if (!removedItems.includes(item)) {
                trulyNewItems.push(item);
              }
            }
            itemsToRemoveFirst.sort((a, b) => b.index - a.index);
            let adjustedStart = actualStart;
            for (const { index } of itemsToRemoveFirst) {
              if (index < actualStart) {
                adjustedStart--;
              }
            }
            const reusedItemSet = new Set(itemsToRemoveFirst.map(({ item }) => item));
            const stagedMoves: OwnershipMove[] = [];
            if (isChildField) {
              // Ownership FACTS for the squash: removed-and-not-reinserted →
              // orphan from THIS slot; every (re)inserted model → adopt. Reuse
              // classifies against STALE mid-region membership — an element
              // staged elsewhere still shows up in backingArray — so
              // reinsertions must declare their adoption too; the engine
              // no-ops true reaffirmations.
              for (const item of removedItems) {
                if (item instanceof PlexusModel && !reusedItemSet.has(item) && !itemsToInsert.includes(item)) {
                  stagedMoves.push({ child: item, orphan: true, from: { parent: owner, field: key } });
                }
              }
              for (const item of itemsToInsert) {
                if (item instanceof PlexusModel) stagedMoves.push({ child: item, parent: owner, field: key });
              }
            }
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                if (itemsToInsert.length > 0) ensureYjsArray();
                return maybeTransacting(owner.__doc__, () => {
                  const actualStart =
                    start < 0 ? Math.max(backingArray.length + start, 0) : Math.min(start, backingArray.length);
                  const actualDeleteCount =
                    deleteCount === undefined
                      ? backingArray.length - actualStart
                      : Math.max(0, Math.min(deleteCount, backingArray.length - actualStart));

                  // Track which items are being removed from the splice zone
                  const removedItems = backingArray.slice(actualStart, actualStart + actualDeleteCount);

                  // Detect items being moved within the same array
                  // These items exist in the array outside the splice zone and need to be removed first

                  // For child fields, validate that items to insert don't contain duplicates
                  if (isChildField && itemsToInsert.length > 0) {
                    PlexusDuplicateChildError.uniquenessInvariant(itemsToInsert, owner, key, "splice");
                  }

                  const itemsToRemoveFirst: Array<{ item: T; index: number }> = [];
                  const trulyNewItems: T[] = [];

                  for (const item of itemsToInsert) {
                    const existingIndex = backingArray.indexOf(item);
                    if (
                      existingIndex !== -1 &&
                      (existingIndex < actualStart || existingIndex >= actualStart + actualDeleteCount)
                    ) {
                      // Item exists elsewhere in array - needs to be removed from old position first
                      itemsToRemoveFirst.push({ item, index: existingIndex });
                    } else if (!removedItems.includes(item)) {
                      // Item is truly new (not in array at all)
                      trulyNewItems.push(item);
                    }
                  }

                  // VALIDATION: Validate truly new items BEFORE any state modification
                  // Note: itemsToRemoveFirst don't need validation since they're already in the array with correct parent
                  if (isChildField) {
                    for (const item of trulyNewItems) {
                      item?.[validateAdoptionSymbol]?.(owner, key);
                    }
                  }

                  // Remove reused items from their old positions first (in reverse order to maintain indices)
                  itemsToRemoveFirst.sort((a, b) => b.index - a.index);
                  for (const { index } of itemsToRemoveFirst) {
                    backingArray.splice(index, 1);
                  }

                  // Adjust splice position if we removed items before it
                  let adjustedStart = actualStart;
                  for (const { index } of itemsToRemoveFirst) {
                    if (index < actualStart) {
                      adjustedStart--;
                    }
                  }

                  // Now perform the splice
                  const result = backingArray.splice(adjustedStart, actualDeleteCount, ...itemsToInsert);

                  // Update parent tracking for child fields
                  if (isChildField) {
                    // Items being truly removed (not reused elsewhere) need
                    // orphanization — but only when they actually RESIDE here.
                    // A flush-time residue sweep or an emancipation re-enters
                    // this proxy while the child's pointers name another home
                    // (or none): content-only removal then, pointers preserved.
                    const reusedItemSet = new Set(itemsToRemoveFirst.map(({ item }) => item));
                    for (const item of removedItems) {
                      if (
                        item instanceof PlexusModel &&
                        !reusedItemSet.has(item as T) &&
                        !itemsToInsert.includes(item as T) &&
                        item.parent === owner &&
                        item.parentField === key
                      ) {
                        item[informOrphanizationSymbol]?.();
                      }
                    }

                    // Truly new items need adoption
                    for (const item of trulyNewItems) {
                      item?.[requestAdoptionSymbol]?.(owner, key);
                    }

                    // Reused items just need inform adoption (parent tracking already exists)
                    for (const { item } of itemsToRemoveFirst) {
                      item?.[informAdoptionSymbol]?.(owner, key);
                    }
                  }

                  // Sync to Y.js with optimized operations
                  const yjsArray = getYjsArray();
                  if (yjsArray) {
                    // For reused items, we need to remove them from old positions first
                    // itemsToRemoveFirst is already sorted in reverse order (line 141)
                    for (const { index } of itemsToRemoveFirst) {
                      yjsArray.delete(index, 1);
                    }

                    // Adjust delete position if we removed items before it
                    let adjustedYjsStart = actualStart;
                    for (const { index } of itemsToRemoveFirst) {
                      if (index < actualStart) {
                        adjustedYjsStart--;
                      }
                    }

                    // Delete items from splice zone
                    if (actualDeleteCount > 0) {
                      yjsArray.delete(adjustedYjsStart, actualDeleteCount);
                    }

                    // Insert all items
                    if (itemsToInsert.length > 0) {
                      yjsArray.insert(
                        adjustedYjsStart,
                        itemsToInsert.map((element) => maybeReference(element, owner.__doc__!)),
                      );
                    }
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return result;
                });
              },
              overlay: () => {
                if (isChildField) {
                  for (const item of trulyNewItems) {
                    item?.[validateAdoptionSymbol]?.(owner, key);
                  }
                }
                for (const { index } of itemsToRemoveFirst) {
                  backingArray.splice(index, 1);
                }
                backingArray.splice(adjustedStart, actualDeleteCount, ...itemsToInsert);
              },
              materialize: () => {
                if (isChildField) {
                  for (const item of trulyNewItems) {
                    item?.[referenceSymbol]?.(owner.__doc__!);
                  }
                }
              },
              describe: () => {
                if (itemsToInsert.length > 0) ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                for (const { index } of itemsToRemoveFirst) {
                  ops.push({ kind: "array-delete", array: yjsArray, index, length: 1 });
                }
                if (actualDeleteCount > 0) {
                  ops.push({ kind: "array-delete", array: yjsArray, index: adjustedStart, length: actualDeleteCount });
                }
                if (itemsToInsert.length > 0) {
                  ops.push({
                    kind: "array-insert",
                    array: yjsArray,
                    index: adjustedStart,
                    content: itemsToInsert.map((element) => maybeReference(element, owner.__doc__!)),
                  });
                }
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
              moves: stagedMoves,
            });
            return removedItems;
          };
        case "pop": // arr.pop() → remove last element
          return () => {
            if (backingArray.length === 0) {
              return;
            }
            const lastIndex = backingArray.length - 1;
            const removedItem = backingArray[lastIndex];
            const stillExistsElsewhere =
              isChildField && removedItem ? backingArray.indexOf(removedItem) !== lastIndex : false;
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                return maybeTransacting(owner.__doc__, () => {
                  const lastIndex = backingArray.length - 1;
                  const removedItem = backingArray[lastIndex];

                  backingArray.pop();

                  // Update parent tracking - only orphanize if item doesn't
                  // exist elsewhere AND actually resides here (flush-time
                  // sweeps re-enter this proxy for content-only removals).
                  if (isChildField && removedItem instanceof PlexusModel) {
                    const stillExists = backingArray.includes(removedItem);
                    if (!stillExists && removedItem.parent === owner && removedItem.parentField === key) {
                      removedItem[informOrphanizationSymbol]?.();
                    }
                  }

                  // Sync to Y.js
                  const yjsArray = getYjsArray();
                  if (yjsArray && yjsArray.length > 0) {
                    yjsArray.delete(yjsArray.length - 1, 1);
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return removedItem;
                });
              },
              overlay: () => {
                backingArray.pop();
              },
              describe: () => {
                const yjsArray = getYjsArray();
                if (!yjsArray || yjsArray.length === 0) return [];
                return [{ kind: "array-delete", array: yjsArray, index: yjsArray.length - 1, length: 1 }];
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
              moves:
                isChildField && removedItem instanceof PlexusModel && !stillExistsElsewhere
                  ? [{ child: removedItem, orphan: true, from: { parent: owner, field: key } }]
                  : undefined,
            });
            return removedItem;
          };
        case "shift": // arr.shift() → remove first element
          return () => {
            if (backingArray.length === 0) {
              return;
            }
            const removedItem = backingArray[0];
            const stillExistsElsewhere =
              isChildField && removedItem ? backingArray.lastIndexOf(removedItem) !== 0 : false;
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                return maybeTransacting(owner.__doc__, () => {
                  const removedItem = backingArray[0];

                  backingArray.shift();

                  // Update parent tracking - only orphanize if item doesn't
                  // exist elsewhere AND actually resides here (flush-time
                  // sweeps re-enter this proxy for content-only removals).
                  if (isChildField && removedItem instanceof PlexusModel) {
                    const stillExists = backingArray.includes(removedItem);
                    if (!stillExists && removedItem.parent === owner && removedItem.parentField === key) {
                      removedItem[informOrphanizationSymbol]?.();
                    }
                  }

                  // Sync to Y.js
                  const yjsArray = getYjsArray();
                  if (yjsArray && yjsArray.length > 0) {
                    yjsArray.delete(0, 1);
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return removedItem;
                });
              },
              overlay: () => {
                backingArray.shift();
              },
              describe: () => {
                const yjsArray = getYjsArray();
                if (!yjsArray || yjsArray.length === 0) return [];
                return [{ kind: "array-delete", array: yjsArray, index: 0, length: 1 }];
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
              moves:
                isChildField && removedItem instanceof PlexusModel && !stillExistsElsewhere
                  ? [{ child: removedItem, orphan: true, from: { parent: owner, field: key } }]
                  : undefined,
            });
            return removedItem;
          };
        case "reverse": // arr.reverse() → reverse in place
          return () => {
            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                ensureYjsArray();
                return maybeTransacting(owner.__doc__, () => {
                  backingArray.reverse();

                  // Sync to Y.js - replace entire array
                  const yjsArray = getYjsArray();
                  if (yjsArray) {
                    yjsArray.delete(0, yjsArray.length);
                    yjsArray.push(backingArray.map((element) => maybeReference(element, owner.__doc__!)));
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return self;
                });
              },
              overlay: () => {
                backingArray.reverse();
              },
              describe: () => {
                ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                if (yjsArray.length > 0) {
                  ops.push({ kind: "array-delete", array: yjsArray, index: 0, length: yjsArray.length });
                }
                ops.push({
                  kind: "array-insert",
                  array: yjsArray,
                  index: 0,
                  content: backingArray.map((element) => maybeReference(element, owner.__doc__!)),
                });
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.reverse();
              },
            });
            return self;
          };
        case "sort": // arr.sort(compareFn) → sort in place
          return (compareFn?: (a: T, b: T) => number) => {
            const backingSnapshot = backingArray.slice();
            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                ensureYjsArray();
                return maybeTransacting(owner.__doc__, () => {
                  backingArray.sort(compareFn as ((a: T | null, b: T | null) => number) | undefined);

                  // Sync to Y.js - replace entire array
                  const yjsArray = getYjsArray();
                  if (yjsArray) {
                    yjsArray.delete(0, yjsArray.length);
                    yjsArray.push(backingArray.map((element) => maybeReference(element, owner.__doc__!)));
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return self;
                });
              },
              overlay: () => {
                backingArray.sort(compareFn as ((a: T | null, b: T | null) => number) | undefined);
              },
              describe: () => {
                ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                if (yjsArray.length > 0) {
                  ops.push({ kind: "array-delete", array: yjsArray, index: 0, length: yjsArray.length });
                }
                ops.push({
                  kind: "array-insert",
                  array: yjsArray,
                  index: 0,
                  content: backingArray.map((element) => maybeReference(element, owner.__doc__!)),
                });
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
            });
            return self;
          };
        case "copyWithin": // arr.copyWithin(target, start, end) → copy elements within array
          return (target: number, start: number, end?: number) => {
            if (isChildField) {
              // One-time warning: copyWithin on child arrays has special semantics
              if (!copyWithinChildArrayWarningShown) {
                copyWithinChildArrayWarningShown = true;
                console.warn(
                  "copyWithin on child array",
                  "Using copyWithin() on a child array (fields decorated with @syncing.child.list) may throw errors if the operation would create duplicate child references. Unlike normal arrays where copyWithin always succeeds, child arrays enforce uniqueness constraints. Consider using index assignment or splice() for moving items within the array.",
                );
              }

              // For child arrays, copyWithin respects copy semantics
              // If copying would create duplicates, throw an error
              // This is different from operations like push/splice which use move semantics

              // Simulate the copyWithin operation to check for duplicates
              const tempArray = [...backingArray];
              tempArray.copyWithin(target, start, end);

              // Check if any non-null element appears more than once
              PlexusDuplicateChildError.uniquenessInvariant(tempArray, owner, key, "copyWithin");
            }
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                ensureYjsArray();
                return maybeTransacting(owner.__doc__, () => {
                  if (isChildField) {
                    // One-time warning: copyWithin on child arrays has special semantics
                    if (!copyWithinChildArrayWarningShown) {
                      copyWithinChildArrayWarningShown = true;
                      console.warn(
                        "copyWithin on child array",
                        "Using copyWithin() on a child array (fields decorated with @syncing.child.list) may throw errors if the operation would create duplicate child references. Unlike normal arrays where copyWithin always succeeds, child arrays enforce uniqueness constraints. Consider using index assignment or splice() for moving items within the array.",
                      );
                    }

                    // For child arrays, copyWithin respects copy semantics
                    // If copying would create duplicates, throw an error
                    // This is different from operations like push/splice which use move semantics

                    // Simulate the copyWithin operation to check for duplicates
                    const tempArray = [...backingArray];
                    tempArray.copyWithin(target, start, end);

                    // Check if any non-null element appears more than once
                    PlexusDuplicateChildError.uniquenessInvariant(tempArray, owner, key, "copyWithin");
                  }

                  // If we get here, no duplicates would be created - proceed with operation
                  backingArray.copyWithin(target, start, end);

                  // Sync to Y.js - replace entire array
                  const yjsArray = getYjsArray();
                  if (yjsArray) {
                    yjsArray.delete(0, yjsArray.length);
                    yjsArray.push(backingArray.map((element) => maybeReference(element, owner.__doc__!)));
                  }

                  trackModification(self, ACCESS_ALL_SYMBOL);
                  return self;
                });
              },
              overlay: () => {
                backingArray.copyWithin(target, start, end);
              },
              describe: () => {
                ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                if (yjsArray.length > 0) {
                  ops.push({ kind: "array-delete", array: yjsArray, index: 0, length: yjsArray.length });
                }
                ops.push({
                  kind: "array-insert",
                  array: yjsArray,
                  index: 0,
                  content: backingArray.map((element) => maybeReference(element, owner.__doc__!)),
                });
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
            });
            return self;
          };
        case "clear": // arr.clear() → remove all elements
          return () => {
            const priorItems = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                const yjsArray = getYjsArray();
                // Clear parent tracking for all items that actually reside here
                // (flush-time sweeps re-enter proxies for content-only removals).
                if (yjsArray && isChildField) {
                  for (const item of backingArray) {
                    if (item instanceof PlexusModel && item.parent === owner && item.parentField === key) {
                      item[informOrphanizationSymbol]?.();
                    }
                  }
                }

                backingArray.splice(0);
                yjsArray?.delete(0, yjsArray.length);
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              overlay: () => {
                backingArray.splice(0);
              },
              describe: () => {
                const yjsArray = getYjsArray();
                if (!yjsArray || yjsArray.length === 0) return [];
                return [{ kind: "array-delete", array: yjsArray, index: 0, length: yjsArray.length }];
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...priorItems);
              },
              moves: isChildField
                ? priorItems
                    .filter((item): item is T & PlexusModel => item instanceof PlexusModel)
                    .map((child) => ({ child, orphan: true as const, from: { parent: owner, field: key } }))
                : undefined,
            });
          };
        case "assign": // arr.assign(newElements) → replace entire array contents
          return (newElements: Array<T>) => {
            if (newElements.length === backingArray.length && newElements.every((val, i) => val === backingArray[i])) {
              return;
            }
            if (isChildField) {
              PlexusDuplicateChildError.uniquenessInvariant(newElements, owner, key, "assign");
            }
            const removedItems = isChildField ? setDifference(new Set(backingArray), new Set(newElements)) : new Set<T>();
            const addedItems = isChildField ? setDifference(new Set(newElements), new Set(backingArray)) : new Set<T>();
            const stagedMoves: OwnershipMove[] = [];
            for (const item of removedItems) {
              if (item instanceof PlexusModel) {
                stagedMoves.push({ child: item, orphan: true, from: { parent: owner, field: key } });
              }
            }
            // Every asserted member declares its adoption — a KEPT element may
            // be staged elsewhere mid-region (stale membership); the engine
            // no-ops true reaffirmations.
            for (const item of isChildField ? newElements : []) {
              if (item instanceof PlexusModel) stagedMoves.push({ child: item, parent: owner, field: key });
            }
            const backingSnapshot = backingArray.slice();

            emitOrDefer(owner.__doc__, {
              applyNow: () => {
                if (newElements.length > 0) ensureYjsArray();
                maybeTransacting(owner.__doc__, () => {
                  if (isChildField) {
                    // Validate that newElements doesn't contain duplicates
                    PlexusDuplicateChildError.uniquenessInvariant(newElements, owner, key, "assign");

                    // Calculate what needs to be added/removed
                    const removedItems = setDifference(new Set(backingArray), new Set(newElements));
                    const addedItems = setDifference(new Set(newElements), new Set(backingArray));

                    // VALIDATE FIRST: Check all added items can be adopted before any state changes
                    for (const item of addedItems) {
                      item?.[validateAdoptionSymbol]?.(owner, key);
                    }

                    // Now safe to orphan removed items and adopt added items —
                    // orphanize only what actually RESIDES here (flush-time
                    // sweeps re-enter proxies for content-only removals).
                    for (const item of removedItems) {
                      if (item instanceof PlexusModel && item.parent === owner && item.parentField === key) {
                        item[informOrphanizationSymbol]?.();
                      }
                    }
                    for (const item of addedItems) {
                      item?.[requestAdoptionSymbol]?.(owner, key);
                    }
                  }
                  const yjsArray = getYjsArray();

                  backingArray.splice(0, backingArray.length, ...newElements);
                  yjsArray?.delete(0, yjsArray.length);
                  yjsArray?.push(newElements.map((element) => maybeReference(element, owner.__doc__!)));
                  trackModification(self, ACCESS_ALL_SYMBOL);
                });
              },
              overlay: () => {
                if (isChildField) {
                  for (const item of addedItems) {
                    item?.[validateAdoptionSymbol]?.(owner, key);
                  }
                }
                backingArray.splice(0, backingArray.length, ...newElements);
              },
              materialize: () => {
                if (isChildField) {
                  for (const item of addedItems) {
                    item?.[referenceSymbol]?.(owner.__doc__!);
                  }
                }
              },
              describe: () => {
                if (newElements.length > 0) ensureYjsArray();
                const yjsArray = getYjsArray();
                if (!yjsArray || !owner.__doc__) return [];
                const ops: YjsOp[] = [];
                if (yjsArray.length > 0) {
                  ops.push({ kind: "array-delete", array: yjsArray, index: 0, length: yjsArray.length });
                }
                if (newElements.length > 0) {
                  ops.push({
                    kind: "array-insert",
                    array: yjsArray,
                    index: 0,
                    content: newElements.map((element) => maybeReference(element, owner.__doc__!)),
                  });
                }
                return ops;
              },
              notify: () => {
                trackModification(self, ACCESS_ALL_SYMBOL);
              },
              revertOverlay: () => {
                backingArray.splice(0, backingArray.length, ...backingSnapshot);
              },
              moves: stagedMoves,
            });
          };
        case "length": // Report length access to this array
          trackAccess(owner, key);
          trackAccess(self, ENTRIES_LENGTH_SYMBOL);
          return backingArray.length;
        case materializationSymbol:
          return () => {
            const yjsArray = getYjsArray();
            if (!yjsArray) {
              // Container absent or removed (e.g., by undo) — clear the proxy
              backingArray.splice(0);
              return;
            }
            invariant(
              yjsArray.doc,
              `Plexus<${owner.__type__}#${owner.uuid}.${key}>: materialization triggered for Y.Array without doc`,
            );
            const materializedItems = yjsArray.toArray().map((item) => deref(yjsArray.doc!, item) as T);

            // DUPLICATE VALIDATION: Verify YJS data doesn't contain duplicates
            // This should never happen, but corrupted data or bugs could create this state
            if (isChildField) {
              PlexusDuplicateChildError.uniquenessInvariant(materializedItems, owner, key, "materialization");
            }

            backingArray.splice(0, backingArray.length, ...materializedItems);
            attachObserver(yjsArray);
          };
        case Symbol.iterator:
          return () => {
            trackAccess(owner, key);
            trackAccess(self, ACCESS_ALL_SYMBOL);
            return backingArray[Symbol.iterator]();
          };
        case Symbol.toStringTag:
          return "Array";
        case Symbol.isConcatSpreadable:
          return true;
      }

      // eslint-disable-next-line sonarjs/no-in-misuse
      if (elementKey in Array.prototype) {
        if (typeof Array.prototype[elementKey] === "function") {
          // Mutating methods (ARRAY_METHODS.mutating): clone → mutate → resync.
          if (mutableArrayMethods.has(elementKey)) {
            return (...args) => {
              const array = backingArray;
              const resultingArray = [...array];
              const result = resultingArray[elementKey](...args);
              if (resultingArray.length === array.length && resultingArray.every((val, i) => val === array[i])) {
                return result;
              }

              if (isChildField) {
                PlexusDuplicateChildError.uniquenessInvariant(resultingArray, owner, key, String(elementKey));
              }
              const removedItems = setDifference(new Set(backingArray), new Set(resultingArray));
              const addedItems = setDifference(new Set(resultingArray), new Set(backingArray));
              // Child fields only — refs don't own, so a ref-array mutation
              // must stage no ownership claims. Wholesale replacement asserts
              // the FULL content: kept elements re-declare adoption too (they
              // may be staged elsewhere mid-region); the engine no-ops true
              // reaffirmations.
              const stagedMoves: OwnershipMove[] = [];
              if (isChildField) {
                for (const item of removedItems) {
                  if (item instanceof PlexusModel) {
                    stagedMoves.push({ child: item, orphan: true, from: { parent: owner, field: key } });
                  }
                }
                for (const item of resultingArray) {
                  if (item instanceof PlexusModel) stagedMoves.push({ child: item, parent: owner, field: key });
                }
              }
              const backingSnapshot = backingArray.slice();

              emitOrDefer(owner.__doc__, {
                applyNow: () => {
                  ensureYjsArray();
                  const yjsArray = getYjsArray();
                  return maybeTransacting(yjsArray?.doc, () => {
                    // DUPLICATE VALIDATION: Check if the array method created duplicates
                    // This shouldn't happen with standard array methods, but validates against potential bugs
                    if (isChildField) {
                      PlexusDuplicateChildError.uniquenessInvariant(resultingArray, owner, key, String(elementKey));
                    }

                    // Calculate what needs to be added/removed
                    const removedItems = setDifference(new Set(backingArray), new Set(resultingArray));
                    const addedItems = setDifference(new Set(resultingArray), new Set(backingArray));

                    // VALIDATE FIRST: Check all added items can be adopted before any state changes
                    if (isChildField) {
                      for (const item of addedItems) {
                        item?.[validateAdoptionSymbol]?.(owner, key);
                      }
                    }

                    // Now safe to orphan removed items and adopt added items —
                    // orphanize only what actually RESIDES here (flush-time
                    // sweeps re-enter proxies for content-only removals).
                    for (const item of removedItems) {
                      if (item instanceof PlexusModel && item.parent === owner && item.parentField === key) {
                        item[informOrphanizationSymbol]?.();
                      }
                    }
                    for (const item of addedItems) {
                      item?.[requestAdoptionSymbol]?.(owner, key);
                    }
                    // backing array update should happen AFTER removed/added items calculation as it uses previous version of backing array
                    backingArray.splice(0, backingArray.length, ...resultingArray);

                    // todo optimized update strategy
                    yjsArray?.delete(0, yjsArray.length);
                    yjsArray?.push(resultingArray.map((element) => maybeReference(element, owner.__doc__!)));
                    trackModification(self, ACCESS_ALL_SYMBOL);
                    return result;
                  });
                },
                overlay: () => {
                  if (isChildField) {
                    for (const item of addedItems) {
                      item?.[validateAdoptionSymbol]?.(owner, key);
                    }
                  }
                  backingArray.splice(0, backingArray.length, ...resultingArray);
                },
                materialize: () => {
                  if (isChildField) {
                    for (const item of addedItems) {
                      item?.[referenceSymbol]?.(owner.__doc__!);
                    }
                  }
                },
                describe: () => {
                  ensureYjsArray();
                  const yjsArray = getYjsArray();
                  if (!yjsArray || !owner.__doc__) return [];
                  const ops: YjsOp[] = [];
                  if (yjsArray.length > 0) {
                    ops.push({ kind: "array-delete", array: yjsArray, index: 0, length: yjsArray.length });
                  }
                  ops.push({
                    kind: "array-insert",
                    array: yjsArray,
                    index: 0,
                    content: resultingArray.map((element) => maybeReference(element, owner.__doc__!)),
                  });
                  return ops;
                },
                notify: () => {
                  trackModification(self, ACCESS_ALL_SYMBOL);
                },
                revertOverlay: () => {
                  backingArray.splice(0, backingArray.length, ...backingSnapshot);
                },
                moves: stagedMoves,
              });
              return result;
            };
          }
          // Read-only methods (ARRAY_METHODS.readonly): delegate to the backing
          // array. Gated by the classification so dispatch can't drift from the guard.
          if (arrayReadonlyMethods.has(elementKey)) {
            return (...args) => {
              trackAccess(owner, key);
              trackAccess(self, ACCESS_ALL_SYMBOL);
              return backingArray[elementKey](...args);
            };
          }
        }
        // Non-function prototype members, and any fn prop outside the classified
        // surface (e.g. `constructor`): return it directly with keyset tracking.
        trackAccess(owner, key);
        trackAccess(self, elementKey);
        return Array.prototype[elementKey];
      }
      // ARRAY ELEMENT ACCESS: arr[0] → deref(yArray.get(0))
      // Converts YJS References back to live entity objects
      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          // Report specific index access
          trackAccess(owner, key);
          trackAccess(self, elementKey);
          return backingArray[parsedElementKey];
        }
      }
    },

    set(_, elementKey, value) {
      // Ensure container exists before tracked transaction for index assignment.
      // Mid-region this is an EAGER yjs write, and an exempt one: field-array
      // container genesis is DETERMINISTIC — `materializeArrayForField` (via
      // `materializeVirtualStruct`) would mint the identical empty container at
      // flush, so creating it now changes no observable content and cannot
      // diverge from the deferred replay.
      if (
        typeof elementKey === "string" &&
        elementKey !== "length" &&
        Number.isSafeInteger(Number.parseInt(elementKey))
      ) {
        ensureYjsArray();
      }

      if (elementKey === "length") {
        // Handle array length truncation
        const newLength = Number(value);
        if (!(Number.isSafeInteger(newLength) && newLength >= 0)) {
          return false;
        }

        const truncating = newLength < backingArray.length;
        const extending = newLength > backingArray.length;
        const removedForTruncation = truncating && isChildField ? backingArray.slice(newLength) : [];
        const gapSize = extending ? newLength - backingArray.length : 0;
        const backingSnapshot = backingArray.slice();

        emitOrDefer(owner.__doc__, {
          applyNow: () => {
            return maybeTransacting(owner.__doc__, () => {
              const newLength = Number(value);
              const yjsArray = getYjsArray();
              if (Number.isSafeInteger(newLength) && newLength >= 0) {
                if (newLength < backingArray.length) {
                  // Clear parent tracking for truncated items that actually
                  // reside here (flush-time sweeps re-enter proxies for
                  // content-only removals).
                  if (isChildField) {
                    for (const item of backingArray.slice(newLength)) {
                      if (item instanceof PlexusModel && item.parent === owner && item.parentField === key) {
                        item[informOrphanizationSymbol]?.();
                      }
                    }
                  }
                  backingArray.length = newLength;

                  yjsArray?.delete(newLength, yjsArray.length - newLength);
                } else if (newLength > backingArray.length) {
                  const gap = [] as null[];
                  while (backingArray.length + gap.length < newLength) {
                    gap.push(null);
                  }
                  backingArray.push(...gap);
                  yjsArray?.push(gap);
                }
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
                return true;
              }
              return false;
            });
          },
          overlay: () => {
            if (truncating) {
              backingArray.length = newLength;
            } else if (extending) {
              const gap: null[] = [];
              while (gap.length < gapSize) {
                gap.push(null);
              }
              backingArray.push(...gap);
            }
          },
          describe: () => {
            const yjsArray = getYjsArray();
            if (!yjsArray) return [];
            if (truncating) {
              const deleteLength = yjsArray.length - newLength;
              return deleteLength > 0
                ? [{ kind: "array-delete", array: yjsArray, index: newLength, length: deleteLength }]
                : [];
            }
            if (extending) {
              const gap: null[] = [];
              while (gap.length < gapSize) {
                gap.push(null);
              }
              return [{ kind: "array-insert", array: yjsArray, index: yjsArray.length, content: gap }];
            }
            return [];
          },
          notify: () => {
            trackModification(self, KEYS_SYMBOL);
            trackModification(self, ENTRIES_LENGTH_SYMBOL);
          },
          revertOverlay: () => {
            backingArray.splice(0, backingArray.length, ...backingSnapshot);
          },
          moves: removedForTruncation
            .filter((item): item is T & PlexusModel => item instanceof PlexusModel)
            .map((child) => ({ child, orphan: true as const, from: { parent: owner, field: key } })),
        });
        return true;
      }

      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          if (parsedElementKey < 0) {
            console.warn(`cannot set [${parsedElementKey}] as it's below zero`);
            return false;
          }

          if (backingArray[parsedElementKey] === value) {
            // STALE-MEMBERSHIP RULE: mid-region the backing array is stale —
            // the child sitting at this index may have been staged AWAY to
            // another parent by an earlier deferred statement. Reaffirming it
            // here must re-assert ownership (last assignment wins), exactly
            // like map's same-value fast path: a moves-only emission with
            // no-op arms. Outside a region the engine ignores `moves` and
            // `applyNow` is the plain early-return; a true reaffirmation is
            // gated against EFFECTIVE ownership in the squash, so an
            // already-settled child stages nothing.
            if (isChildField && value instanceof PlexusModel) {
              emitOrDefer(owner.__doc__, {
                applyNow: () => true,
                overlay: () => {},
                describe: () => [],
                notify: () => {},
                revertOverlay: () => {},
                moves: [{ child: value, parent: owner, field: key }],
              });
            }
            return true;
          }

          const originalLength = backingArray.length;
          let isReuse = false;
          let reuseFromIndex = -1;
          let targetIndex = parsedElementKey;
          let oldItem: T | null = null;
          if (isChildField) {
            const scratch = backingArray.slice();
            while (scratch.length < parsedElementKey) {
              scratch.push(null as any);
            }
            const existingIndex = scratch.indexOf(value);
            isReuse = existingIndex !== -1 && existingIndex !== parsedElementKey;
            if (isReuse) {
              reuseFromIndex = existingIndex;
              scratch.splice(existingIndex, 1);
              if (existingIndex < parsedElementKey) {
                targetIndex = parsedElementKey - 1;
              }
            }
            oldItem = (scratch[targetIndex] ?? null) as T | null;
          }
          const backingSnapshot = backingArray.slice();

          emitOrDefer(owner.__doc__, {
            applyNow: () => {
              return maybeTransacting(owner.__doc__, () => {
                // Track original length to detect extension
                const originalLength = backingArray.length;

                // Fill holes with null to match YJS behavior
                while (backingArray.length < parsedElementKey) {
                  trackModification(self, `${backingArray.length}`);
                  backingArray.push(null as any);
                }

                // Handle parent tracking for replaced item
                let isReuse = false;
                let reuseFromIndex = -1;
                let targetIndex = parsedElementKey;
                if (isChildField) {
                  // Check if this is a reuse (value exists elsewhere in array)
                  const existingIndex = backingArray.indexOf(value);
                  isReuse = existingIndex !== -1 && existingIndex !== parsedElementKey;

                  // VALIDATE FIRST: For non-reuse case, validate BEFORE any state changes
                  // This ensures we don't corrupt state if validation throws (e.g., cycle detection)
                  if (!isReuse) {
                    value?.[validateAdoptionSymbol]?.(owner, key);
                  }

                  // If reusing an item from elsewhere in array, remove it from old position first
                  // This prevents duplicates and maintains "child can only appear once" invariant
                  // Child arrays use splice semantics (compact/shift), not sparse array semantics
                  if (isReuse) {
                    reuseFromIndex = existingIndex; // Store for YJS sync
                    trackModification(self, ACCESS_ALL_SYMBOL);
                    backingArray.splice(existingIndex, 1);
                    // Adjust target index if we removed an item before it
                    if (existingIndex < parsedElementKey) {
                      targetIndex = parsedElementKey - 1;
                    }
                  }

                  // Save old item at target position (after potential splice adjustment)
                  const oldItem = backingArray[targetIndex];

                  // Orphanize old item if it differs from the new value and
                  // actually RESIDES here (flush-time sweeps re-enter this
                  // proxy for content-only removals).
                  if (
                    oldItem instanceof PlexusModel &&
                    oldItem !== value &&
                    oldItem.parent === owner &&
                    oldItem.parentField === key
                  ) {
                    oldItem[informOrphanizationSymbol]?.();
                  }

                  // For new items (not reuse), call requestAdoptionSymbol
                  if (!isReuse) {
                    value?.[requestAdoptionSymbol]?.(owner, key);
                  }
                }

                backingArray[targetIndex] = value;

                const yjsArray = getYjsArray();
                // Handle YJS sync
                if (yjsArray) {
                  if (isReuse && reuseFromIndex !== -1) {
                    // For reused items, we removed from reuseFromIndex and set at targetIndex
                    // Replicate the same operations in YJS:
                    // 1. Delete from original position
                    yjsArray.delete(reuseFromIndex, 1);

                    // 2. Delete the item being replaced (at adjusted position after first delete)
                    if (targetIndex >= yjsArray.length) {
                      // Extending: fill holes and append
                      const postfix: (typeof value | null)[] = [];
                      while (postfix.length + yjsArray.length < targetIndex) {
                        postfix.push(null);
                      }
                      postfix.push(maybeReference(value, owner.__doc__!));
                      // we're doing it that way to make operation atomic
                      yjsArray.push(postfix);
                    } else {
                      yjsArray.delete(targetIndex, 1);
                      // 3. Insert new value at target
                      yjsArray.insert(targetIndex, [maybeReference(value, owner.__doc__!)]);
                    }
                  } else if (parsedElementKey >= yjsArray.length) {
                    // Extending array
                    const postfix: null[] = [];
                    while (postfix.length + yjsArray.length < parsedElementKey) {
                      postfix.push(null);
                    }
                    // we're doing it that way to make operation atomic
                    yjsArray.push([...postfix, maybeReference(value, owner.__doc__!)]);
                  } else {
                    // Replacing existing element
                    yjsArray.delete(parsedElementKey, 1);
                    yjsArray.insert(parsedElementKey, [maybeReference(value, owner.__doc__!)]);
                  }
                }

                // For reused items, call informAdoptionSymbol after the move
                if (isChildField && isReuse) {
                  value?.[informAdoptionSymbol]?.(owner, key);
                }
                trackModification(self, `${targetIndex}`);

                // Emit KEYS_SYMBOL if array was extended (length changed)
                if (backingArray.length > originalLength) {
                  trackModification(self, KEYS_SYMBOL);
                  trackModification(self, ENTRIES_LENGTH_SYMBOL);
                }

                return true;
              });
            },
            overlay: () => {
              if (isChildField && !isReuse) {
                value?.[validateAdoptionSymbol]?.(owner, key);
              }
              while (backingArray.length < parsedElementKey) {
                backingArray.push(null as any);
              }
              if (isChildField && isReuse) {
                backingArray.splice(reuseFromIndex, 1);
              }
              backingArray[targetIndex] = value;
            },
            materialize: () => {
              if (isChildField && !isReuse) {
                value?.[referenceSymbol]?.(owner.__doc__!);
              }
            },
            describe: () => {
              const yjsArray = getYjsArray();
              if (!yjsArray || !owner.__doc__) return [];
              const ops: YjsOp[] = [];
              if (isReuse && reuseFromIndex !== -1) {
                ops.push({ kind: "array-delete", array: yjsArray, index: reuseFromIndex, length: 1 });
                const postDeleteLength = yjsArray.length - 1;
                if (targetIndex >= postDeleteLength) {
                  const postfix: AllowedYValue[] = [];
                  while (postfix.length + postDeleteLength < targetIndex) {
                    postfix.push(null);
                  }
                  postfix.push(maybeReference(value, owner.__doc__));
                  ops.push({ kind: "array-insert", array: yjsArray, index: postDeleteLength, content: postfix });
                } else {
                  ops.push({ kind: "array-delete", array: yjsArray, index: targetIndex, length: 1 });
                  ops.push({
                    kind: "array-insert",
                    array: yjsArray,
                    index: targetIndex,
                    content: [maybeReference(value, owner.__doc__)],
                  });
                }
              } else if (parsedElementKey >= yjsArray.length) {
                const postfix: AllowedYValue[] = [];
                while (postfix.length + yjsArray.length < parsedElementKey) {
                  postfix.push(null);
                }
                postfix.push(maybeReference(value, owner.__doc__));
                ops.push({ kind: "array-insert", array: yjsArray, index: yjsArray.length, content: postfix });
              } else {
                ops.push({ kind: "array-delete", array: yjsArray, index: parsedElementKey, length: 1 });
                ops.push({
                  kind: "array-insert",
                  array: yjsArray,
                  index: parsedElementKey,
                  content: [maybeReference(value, owner.__doc__)],
                });
              }
              return ops;
            },
            notify: () => {
              for (let i = originalLength; i < parsedElementKey; i++) {
                trackModification(self, `${i}`);
              }
              if (isChildField && isReuse) {
                trackModification(self, ACCESS_ALL_SYMBOL);
              }
              trackModification(self, `${targetIndex}`);
              if (backingArray.length > originalLength) {
                trackModification(self, KEYS_SYMBOL);
                trackModification(self, ENTRIES_LENGTH_SYMBOL);
              }
            },
            revertOverlay: () => {
              backingArray.splice(0, backingArray.length, ...backingSnapshot);
            },
            // Replaced occupant → orphan from THIS slot; the incoming value →
            // adopt, for reuse too (stale-membership rule; the engine no-ops
            // true reaffirmations). Refs stage nothing — refs don't own.
            moves: isChildField
              ? [
                  ...(oldItem instanceof PlexusModel && oldItem !== value
                    ? [{ child: oldItem, orphan: true as const, from: { parent: owner, field: key } }]
                    : []),
                  ...(value instanceof PlexusModel ? [{ child: value, parent: owner, field: key }] : []),
                ]
              : undefined,
          });
          return true;
        }
      }
      console.warn(`cannot set property ${elementKey.toString()} as it's non-declared`);
      return false;
    },
    deleteProperty() {
      return false;
    },
    // todo getOwnPropertyDescriptor
    setPrototypeOf() {
      return false;
    },
    has(_, elementKey) {
      if (elementKey === "length") {
        return true;
      }
      if (typeof elementKey === "string") {
        const parsedElementKey = Number.parseInt(elementKey);
        if (Number.isSafeInteger(parsedElementKey)) {
          return parsedElementKey >= 0 && parsedElementKey < backingArray.length;
        }
      }
      // eslint-disable-next-line sonarjs/no-in-misuse
      return elementKey in Array.prototype;
    },
    ownKeys(target) {
      trackAccess(owner, key);
      trackAccess(self, KEYS_SYMBOL);
      return Reflect.ownKeys(target);
    },
  });
  return self as T[] & ReadonlyField<T[]>;
};
