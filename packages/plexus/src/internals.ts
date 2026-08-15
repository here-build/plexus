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

/** Ownership protocol. Adoption, orphanization and materialization are driven by
 *  symbol-keyed methods on the proxies so they cannot collide with model fields. */
export {
  bytesProxyRawSymbol,
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
export { type ConcretePlexusConstructor, isBoundEntity, safeUuid } from "./PlexusModel.js";

/** Shadow/authoring doc registries. `docPlexus` and `docTransactionOrigin` are
 *  the two with callers and remain on the root export. */
export { docAuthoring, docLiminality } from "./plexus-registry.js";

/** Thrown by the constructor under `PlexusOptions.testSentinel` to prove
 *  reachability. Never crosses a doc. */
export { PLEXUS_TEST_SENTINEL } from "./sentinels.js";
