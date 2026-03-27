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
import { GENESIS_BASE } from "./genesis-client.js";
import { docPlexus } from "./plexus-registry.js";
import { Plexus } from "./Plexus.js";
import { getInternals, PlexusModel } from "./PlexusModel.js";
import { serializeKey } from "./proxies/key-serialization.js";
import type { AllowedVirtualMapKey, AllowedYValue } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";

// ── Constants ──

/** Origin used for the yjsMap.set() that registers the root UUID pointer. */
export const GENESIS_ORIGIN = Symbol("plexus:genesis");

/** Hash seeds — "GEN" and "SIS" in hex-ish (shared with genesis-client.ts) */
const SEED_HI = 0x47_45_4e;
const SEED_LO = 0x53_49_53;

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
  for (let k of data) {
    k = Math.imul(k, 0xcc_9e_2d_51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b_87_35_93);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6_54_6b_64) >>> 0;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85_eb_ca_6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2_b2_ae_35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Genesis hash space: [GENESIS_BASE, MAX_SAFE_INTEGER]. */
const GENESIS_RANGE = Number.MAX_SAFE_INTEGER - GENESIS_BASE + 1;

/**
 * Compute a deterministic genesis clientId for a virtual child.
 * Returns a value in [GENESIS_BASE, MAX_SAFE_INTEGER] — the genesis namespace.
 */
function computeVirtualGenesisId(
  parentUuid: string,
  fieldName: string,
  serializedKey: string,
  vector: Uint8Array,
): number {
  const vectorHash = murmurBytes(vector, SEED_HI);
  const canonical = String.raw`${parentUuid}\0${fieldName}\0${serializedKey}\0${vectorHash.toString(36)}`;
  const hi = murmur32(canonical, SEED_HI);
  const lo = murmur32(canonical, SEED_LO);
  const wide = (hi & 0x1f_ff_ff) * 0x1_00_00_00_00 + (lo >>> 0);
  return (wide % GENESIS_RANGE) + GENESIS_BASE;
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
 * Validate that a key is a valid virtual map key.
 *
 * Allowed: primitives, primitive arrays, and PlexusModel instances connected
 * to a Y.Doc (their UUID provides deterministic serialization for
 * content-addressed genesis).
 *
 * Rejected: disconnected PlexusModel (non-deterministic), Sets, other types.
 */
function assertValidKey(key: unknown): void {
  if (Array.isArray(key)) {
    for (const item of key) {
      assertValidKey(item);
    }
    return;
  }
  if (key instanceof PlexusModel) {
    invariant(key.__doc__, "PlexusModel key must be connected to a doc for deterministic serialization");
    return;
  }
  const type = typeof key;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint") {
    return;
  }
  invariant(!(key instanceof Set), "Sets are not allowed as virtual child keys");
  invariant(false, `Invalid virtual child key type: ${type}`);
}

function computeContainerGenesisId(parentUuid: string, fieldName: string): number {
  const canonical = `${parentUuid}\0${fieldName}\0__container__`;
  const hi = murmur32(canonical, SEED_HI);
  const lo = murmur32(canonical, SEED_LO);
  const wide = (hi & 0x1f_ff_ff) * 0x1_00_00_00_00 + (lo >>> 0);
  return (wide % GENESIS_RANGE) + GENESIS_BASE;
}

function materializeVirtualStruct(owner: PlexusModel, fieldName: string, value: Y.AbstractType<any>): void {
  const doc = owner.__doc__;
  invariant(doc != null, "materializeVirtualStruct: document should be available for virtual genesis");
  const genesisId = computeContainerGenesisId(owner.uuid, fieldName);

  // Snapshot real doc state before genesis
  const sv = Y.encodeStateVector(doc);

  // Create isolated temp doc with genesis clientId + real doc state
  const tmpDoc = new Y.Doc({ guid: doc.guid });
  Object.defineProperty(tmpDoc, "clientID", {
    get: () => genesisId,
    set: () => {},
    configurable: true,
  });
  Y.applyUpdate(tmpDoc, Y.encodeStateAsUpdate(doc));

  const tmpSubMap = tmpDoc
    .getMap<Y.Map<Y.XmlElement<Record<string, Y.AbstractType<any>>>>>("types")
    .get(owner.__type__);
  invariant(tmpSubMap, `materializeVirtualStruct: type map for ${owner.__type__} not found in temp doc`);
  const tmpElement = tmpSubMap.get(owner.uuid);
  invariant(tmpElement, `materializeVirtualStruct: entity ${owner.__type__}#${owner.uuid} not found in temp doc`);
  tmpElement.setAttribute(fieldName, value);

  // Encode only the genesis Items (diff since snapshot)
  const diff = Y.encodeStateAsUpdate(tmpDoc, sv);
  tmpDoc.destroy();

  // Merge into real doc — Items carry genesis clientId, UndoManager ignores them
  Y.applyUpdate(doc, diff);
}

export function materializeMapForField(owner: PlexusModel, fieldName: string): Y.Map<AllowedYValue> {
  const wrapper = owner.__yjsFieldsMap__!;
  const existing = wrapper.get(fieldName);
  if (existing) return existing as Y.Map<AllowedYValue>;

  materializeVirtualStruct(owner, fieldName, new Y.Map<AllowedYValue>());
  return wrapper.get(fieldName) as Y.Map<AllowedYValue>;
}

export function materializeArrayForField(owner: PlexusModel, fieldName: string): Y.Array<AllowedYValue> {
  const wrapper = owner.__yjsFieldsMap__!;
  const existing = wrapper.get(fieldName);
  if (existing) return existing as Y.Array<AllowedYValue>;

  materializeVirtualStruct(owner, fieldName, new Y.Array<AllowedYValue>());
  return wrapper.get(fieldName) as Y.Array<AllowedYValue>;
}

/**
 * Create a deterministic, undo-invisible CRDT entity via content-addressed genesis.
 *
 * The entity's identity is a pure function of (owner, field, key, shape).
 * Two independent peers calling this with the same inputs get identical Yjs Items.
 *
 * @param owner     Parent model (must be connected to a doc)
 * @param fieldName Field on parent (must be a child-map field)
 * @param mapKey    Primitive, primitive[], or doc-connected PlexusModel key
 * @param yjsMap    Parent's Y.Map for this field
 * @param factory   Creates entity tree — isolated, cannot access external models
 */
export function materializeVirtualChild<K extends AllowedVirtualMapKey, V extends PlexusModel>(
  owner: PlexusModel,
  fieldName: string,
  mapKey: K,
  yjsMap: Y.Map<AllowedYValue>,
  factory: (key: K) => V,
): void {
  // Validate prerequisites
  const doc = owner.__doc__;
  invariant(doc, `materializeVirtualChild: owner ${owner.__type__} must be connected to a doc`);
  assertValidKey(mapKey);

  yjsMap ??= materializeMapForField(owner, fieldName);

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
