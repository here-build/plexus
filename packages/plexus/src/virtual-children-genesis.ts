/**
 * Virtual Children Genesis — content-addressed, deterministic CRDT entity creation.
 *
 * Like EVM CREATE2 but for Plexus entities: the identity of a virtual child is a
 * pure function of (parent, field, key, shape). Two independent peers producing
 * the same virtual child get identical Yjs Items — sync is a no-op.
 *
 * Applied via Y.applyUpdate → remote change → invisible to UndoManager.
 * Factory isolation ensures the callback cannot read external model state.
 */

import invariant from "tiny-invariant";
import * as Y from "yjs";

import { murmur32 } from "./crdt-uuid.js";
import { docPlexus } from "./plexus-registry.js";
import { getInternals, PlexusModel } from "./PlexusModel.js";
import { serializeKey } from "./proxies/key-serialization.js";
import type { AllowedStatelessYJSMapKey, AllowedYValue } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { Plexus } from "./Plexus.js";

// ── Constants ──

/** Origin used for the yjsMap.set() that registers the root UUID pointer. */
export const GENESIS_ORIGIN = Symbol("plexus:genesis");

/** Hash seeds — "GEN" and "SIS" in hex-ish (shared with genesis-client.ts) */
const SEED_HI = 0x47454e;
const SEED_LO = 0x534953;

// ── Factory Isolation ──

/**
 * When non-null, only models in this set may have their fields accessed.
 * The PlexusModel constructor adds newly created models to this set.
 * Null 99.99% of the time — single null check, effectively free.
 *
 * Shared across nesting levels: nested materializeVirtualChild calls reuse
 * the same WeakSet so sub-context entities are visible to the parent factory.
 * Only the outermost call creates/nulls the allowlist (guarded by genesisDepth).
 */
export let genesisAllowlist: WeakSet<PlexusModel> | null = null;

/** Nesting depth — only the outermost genesis call manages the allowlist lifecycle. */
let genesisDepth = 0;

/** @internal — exposed for tests only */
export function __getGenesisDepth__(): number {
  return genesisDepth;
}

/**
 * Guard for field getters: throws if we're inside a genesis factory
 * and the model wasn't created by that factory.
 */
export function assertGenesisIsolation(model: PlexusModel): void {
  if (!genesisAllowlist) {
    return;
  }
  invariant(
    genesisAllowlist.has(model),
    `Virtual child factory isolation: cannot access ${model.__type__}#${getInternals(model).uuid ?? "<virtual>"} — only models created during factory execution are accessible`,
  );
}

// ── Helpers ──

/**
 * murmur32 over raw bytes (Uint8Array).
 * Same algorithm as the string variant in crdt-uuid.ts, but iterates data[i].
 */
function murmurBytes(data: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    let k = data[i];
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Yjs clientIds are uint32: [0, 0xFFFFFFFF]. Genesis lives above this. */
const MAX_UINT32 = 0xffffffff;

/** Number of integers in (MAX_UINT32, MAX_SAFE_INTEGER]. */
const GENESIS_RANGE = Number.MAX_SAFE_INTEGER - MAX_UINT32;

/**
 * Compute a deterministic genesis clientId for a virtual child.
 * Returns a value in (MAX_UINT32, MAX_SAFE_INTEGER] — structurally above
 * the uint32 range Yjs uses for real clientIds. Collision impossible.
 */
function computeVirtualGenesisId(
  parentUuid: string,
  fieldName: string,
  serializedKey: string,
  vector: Uint8Array,
): number {
  const vectorHash = murmurBytes(vector, SEED_HI);
  const canonical = `${parentUuid}\\0${fieldName}\\0${serializedKey}\\0${vectorHash.toString(36)}`;
  const hi = murmur32(canonical, SEED_HI);
  const lo = murmur32(canonical, SEED_LO);
  const wide = (hi & 0x1fffff) * 0x100000000 + (lo >>> 0);
  return (wide % GENESIS_RANGE) + MAX_UINT32 + 1;
}

/**
 * Force CRDT-native UUID generation regardless of PLEXUS_UUID_MODE.
 * Genesis requires deterministic UUIDs — arbitrary mode would produce random ones.
 */
function withNativeUUIDs<T>(fn: () => T): T {
  if (Plexus.uuidMode) {
    const saved = Plexus.uuidMode;
    Plexus.uuidMode = undefined;
    try {
      return fn();
    } finally {
      Plexus.uuidMode = saved;
    }
  } else {
    return fn();
  }
}

/**
 * Validate that a key is primitive or primitive[].
 * Throws on PlexusModel, Set, or other disallowed types.
 */
function assertPrimitiveKey(key: unknown): void {
  if (Array.isArray(key)) {
    for (const item of key) {
      assertPrimitiveKey(item);
    }
    return;
  }
  const type = typeof key;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint") {
    return;
  }
  invariant(!(key instanceof PlexusModel), "PlexusModel instances are not allowed as virtual child keys");
  invariant(!(key instanceof Set), "Sets are not allowed as virtual child keys");
  invariant(false, `Invalid virtual child key type: ${type}`);
}

// ── Core Function ──

/**
 * Create a deterministic, undo-invisible CRDT entity via content-addressed genesis.
 *
 * The entity's identity is a pure function of (owner, field, key, shape).
 * Two independent peers calling this with the same inputs get identical Yjs Items.
 *
 * @param owner     Parent model (must be connected to a doc)
 * @param fieldName Field on parent (must be a child-map field)
 * @param mapKey    Primitive or primitive[] key
 * @param yjsMap    Parent's Y.Map for this field
 * @param factory   Creates entity tree — isolated, cannot access external models
 */
export function materializeVirtualChild<K extends AllowedStatelessYJSMapKey, V extends PlexusModel>(
  owner: PlexusModel,
  fieldName: string,
  mapKey: K,
  yjsMap: Y.Map<AllowedYValue>,
  factory: (key: K) => V,
): void {
  // Validate prerequisites
  const doc = owner.__doc__;
  invariant(doc, `materializeVirtualChild: owner ${owner.__type__} must be connected to a doc`);
  assertPrimitiveKey(mapKey);

  const ownerUuid = owner.uuid;
  const serializedMapKey = serializeKey(mapKey, doc);

  // Nesting support: only the outermost call creates/nulls the allowlist.
  // Inner calls reuse it — models from sub-contexts are visible to parents.
  const isOutermost = genesisDepth === 0;
  if (isOutermost) genesisAllowlist = new WeakSet();
  genesisDepth++;

  try {
    // ── Phase 1: content hash ──
    // Run factory in isolation, materialize to a temp doc, capture the vector.
    // This vector's content determines the genesis clientId.

    const vector0: Uint8Array = withNativeUUIDs(() => {
      const tmpDoc1 = new Y.Doc({ guid: doc.guid });
      Object.defineProperty(tmpDoc1, "clientID", {
        get() {
          // bypassing yjs guard "Changed the client-id because another client seems to be using it."
          return 0;
        },
        set() {},
      });
      const entity1 = factory(mapKey);
      docPlexus.set(tmpDoc1, null as any); // pass [referenceSymbol] invariant
      entity1[referenceSymbol](tmpDoc1);
      const internals = getInternals(entity1);
      invariant(!internals.isDependency, "Genesis factory must not produce dependency entities");
      // [referenceSymbol] calls __bootstrapObservation__ which registers onChange.
      // Unobserve BEFORE setParentData — otherwise onChange fires on tmpDoc1
      // and tries to deref the parent UUID which doesn't exist in tmpDoc1.
      internals.unobserve?.();
      // Manually set parent data on root entity's XmlElement
      internals.yjsModel!.setParentData(ownerUuid, fieldName, serializedMapKey);
      docPlexus.delete(tmpDoc1);
      const vector = Y.encodeStateAsUpdate(tmpDoc1);
      tmpDoc1.destroy();
      return vector;
    });

    // ── Phase 2: deterministic create ──
    // Fresh factory run, but now the temp doc uses the genesis clientId.
    // This makes all Yjs Items deterministic.

    const tmpDoc2 = new Y.Doc({ guid: doc.guid });
    const genesisId = computeVirtualGenesisId(ownerUuid, fieldName, serializedMapKey, vector0);
    Object.defineProperty(tmpDoc2, "clientID", {
      get() {
        return genesisId;
      },
      set() {},
    });

    let rootUuid: string;
    const vector: Uint8Array = withNativeUUIDs(() => {
      const entity2 = factory(mapKey);
      docPlexus.set(tmpDoc2, null as any);
      entity2[referenceSymbol](tmpDoc2);
      const internals = getInternals(entity2);
      invariant(!internals.isDependency, "Genesis factory must not produce dependency entities");
      // Same as Phase 1: unobserve before setParentData.
      internals.unobserve?.();
      internals.yjsModel!.setParentData(ownerUuid, fieldName, serializedMapKey);
      docPlexus.delete(tmpDoc2);
      rootUuid = entity2.uuid;
      const vector = Y.encodeStateAsUpdate(tmpDoc2);
      tmpDoc2.destroy();
      return vector;
    });

    // ── Apply ──
    // Entities land in type sub-maps (remote → UndoManager ignores).
    Y.applyUpdate(doc, vector);

    // Register the root UUID pointer in the parent's yjsMap.
    // Uses GENESIS_ORIGIN (not Plexus origin) → UndoManager ignores.
    doc.transact(() => {
      yjsMap.set(serializedMapKey, [rootUuid]);
    }, GENESIS_ORIGIN);
  } finally {
    genesisDepth--;
    if (genesisDepth === 0) genesisAllowlist = null;
  }
}
