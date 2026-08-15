/**
 * @here.build/plexus/internals — the package with nothing withheld.
 *
 * DESIGNED EXPOSURE, NOT A LESSER TIER. A package that hides the one handle you
 * need leaves you forking it; this entrypoint is the standing answer to "the
 * intended surface is not enough." Everything here works and is maintained. It
 * is undocumented on purpose — being undocumented is what makes reaching for it
 * a deliberate act.
 *
 * THE SPECIFIER IS THE MARKER. An import from here is an acknowledged violation
 * of the package's own ontology, in the sense `@ts-expect-error` acknowledges a
 * type violation: permitted, visible in the diff, and obliged to carry a reason
 * at the call site. `docPlexus.get(entity.__doc__)` is legal precisely because a
 * Y.Doc is ontologically prior to the models bound to it — but the call site has
 * to say so. The friction is the feature; do not smooth it into an accessor.
 *
 * COMPLEMENT, NOT SUPERSET. This entrypoint carries only what `index.ts` does
 * not, so an internals import line lists violations and nothing else. Ordinary
 * symbols keep coming from the root — two import lines, one of which is the
 * confession.
 */

// CRDT-native UUID codec — reused by @here.build/plexus-history to resolve an
// entity's uuid from a struct in O(1) via encodePlexusUUID(xmlElement._item.id).
export { encode as encodePlexusUUID, decode as decodePlexusUUID } from "./crdt-uuid.js";

/**
 * Ownership protocol, and the storability lattice under it.
 *
 * The protocol is symbol-keyed methods on the proxies, so a model field can
 * never collide with one. The lattice is what yjs can hold, spelled as types —
 * `@syncing` enforces it, which is why a model author writes `string` and never
 * `AllowedYJSValue`. `PlexusUUID`, `VirtualMap`, `AwarenessShape` and
 * `AwarenessSerializable` are the four the vocabulary does reach for, and they
 * stay on the root export.
 */
export {
  type AllowedKeyPrimitive,
  type AllowedPrimitive,
  type AllowedVirtualMapKey,
  type AllowedYJSKeyValue,
  type AllowedYJSMapKey,
  type AllowedYJSValue,
  type AllowedYJSValueList,
  type AllowedYJSValueMap,
  type AllowedYJSValueSet,
  type AllowedYValue,
  bytesProxyRawSymbol,
  type CrossProjectReferenceTuple,
  type GenericRecordSchema,
  type Internals,
  type PlexusTagContainer,
  /** `declare class` — a nominal type with no runtime binding, never a value. */
  type ReadonlyField,
  type ReferenceTuple,
  type Storageable,
  type YPlexusNode,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  referenceSymbol,
  requestAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
} from "./proxy-runtime-types.js";

/** MobX bridge. A field type implemented outside this package reports its reads
 *  and writes through these; the four symbols name the whole-collection trackers
 *  that `Tracker` cannot spell as a key. */
export {
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  KEYS_SYMBOL,
  type Tracker,
  trackAccess,
  trackModification,
  __untracked__,
  VALUES_SYMBOL,
} from "./tracking.js";

/** Cross-document dependency wire format, behind `Plexus.addDependency`. */
export {
  type BlobEntity,
  createBlobFromDoc,
  decodeBlob,
  type DecodedBlob,
  encodeBlob,
} from "./dependency-blob.js";

/** Awareness states-map key algebra. Needed to filter or route lane traffic in a
 *  provider; `PlexusAwareness.resolveKey` is the read side and is public. */
export {
  AWARENESS_LANE_REGISTER,
  AWARENESS_MAX_LANES,
  awarenessChannelId,
  isAwarenessEnumerationKey,
} from "./awareness.js";

/** clientId minting. The namespace PREDICATES are public — asking what kind of
 *  peer an id denotes is an application question; minting one is not. */
export { MAX_UINT32, newClientId } from "./genesis-client.js";

/** Process-local id minting. `resetLocalIDs` is public for fixture determinism. */
export { mintLocalID } from "./local-id.js";

/** Type registry, keyed by `__type__`. Deref resolves a UUID's class through it. */
export { entityClasses } from "./globals.js";

/** Per-entity internals record, and the helpers that read it. */
export {
  type ConcretePlexusConstructor,
  getInternals,
  isBoundEntity,
  safeUuid,
} from "./PlexusModel.js";

/** Doc registries. `docPlexus` inverts the binding — a Y.Doc is ontologically
 *  prior to the models bound to it, so asking a doc for its Plexus reads the
 *  relation backwards. Legal, and the reason belongs at the call site. */
export {
  docAuthoring,
  docLiminality,
  docPlexus,
  docTransactionOrigin,
} from "./plexus-registry.js";

/** Doc key layout — where a Plexus stores its type map, meta and dependencies.
 *  A client asking whether a doc is bootstrapped is asking the wrong party: the
 *  authority that hands over a doc is what guarantees it. */
export * as YJS_GLOBALS from "./YJS_GLOBALS.js";

/** Thrown by the constructor under `PlexusOptions.testSentinel` to prove
 *  reachability. Never crosses a doc. */
export { PLEXUS_TEST_SENTINEL } from "./sentinels.js";
