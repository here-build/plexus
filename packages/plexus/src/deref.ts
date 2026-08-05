// Dereference tuple references via CRDT-native UUID → StructStore resolution

import invariant from "tiny-invariant";
import * as Y from "yjs";

import { decode } from "./crdt-uuid.js";
import { documentEntityCaches } from "./entity-cache.js";
import { isLiminalClientId, LIMINAL_BASE } from "./genesis-client.js";
import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { type ConcretePlexusConstructor, getInternals, PlexusModel } from "./PlexusModel.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYJSValue, AllowedYValue, PlexusUUID, ReferenceTuple, YPlexusNode } from "./proxy-runtime-types.js";
import { isTupleReference } from "./utils/utils.js";

/** Resolve the struct at (clientId, clock), or null if that client/clock isn't present. */
function resolveItem(doc: Y.Doc, clientId: number, clock: number): Y.Item | null {
  // getState returns 0 for an absent client, so this guards both "client missing"
  // and "clock out of range" without getItem throwing.
  if (clock >= Y.getState(doc.store, clientId)) return null;
  return Y.getItem(doc.store, Y.createID(clientId, clock));
}

/**
 * Read-half probe of the awareness coherence law (docs/awareness-coherence.md):
 * can this reference tuple resolve against the local store right now?
 *
 * Cheap and total — no materialization, no cache writes, never throws (a
 * malformed tuple is simply unsatisfiable). Dependency references pass: the
 * dependency-doc registry owns their lifecycle and failure semantics. `deref`
 * itself stays strict; a post-gate deref failure is a bug, not a state.
 */
export function isRefSatisfiable(doc: Y.Doc, pointer: unknown): boolean {
  if (!isTupleReference(pointer)) return false;
  if (pointer[1] !== undefined) return true;
  const entityId = pointer[0];
  // Liminal-kind refs never park: a reverted session's entity is gone FOREVER —
  // there is no future doc state to wait for. The read half resolves them
  // live-or-null instead (tryDerefLiminal).
  if (typeof entityId === "string" && entityId.startsWith("l")) return true;
  const known = documentEntityCaches.get(doc).get(entityId)?.deref();
  if (known) return true;
  try {
    const { clientId, clock } = decode(entityId as PlexusUUID);
    const item = isLiminalClientId(clientId)
      ? (resolveItem(doc, clientId + LIMINAL_BASE, clock) ?? resolveItem(doc, clientId, clock))
      : resolveItem(doc, clientId, clock);
    return item != null && item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlElement;
  } catch {
    return false;
  }
}

/**
 * Awareness read of a liminal-kind reference: the live instance, or null when
 * the session that minted it is over and its structs are dead. Probes the
 * committed ("bound") twin first, then the liminal address — the same
 * precedence strict deref uses — but with a liveness check, because a
 * reverted session's Items are delete-marked while their model instances may
 * still sit in the entity cache. Only the awareness lane calls this: durable
 * deref stays strict.
 */
export function tryDerefLiminal(doc: Y.Doc, pointer: ReferenceTuple): PlexusModel | null {
  try {
    const { clientId, clock } = decode(pointer[0] as PlexusUUID);
    const live = (base: number): boolean => {
      const item = resolveItem(doc, base, clock);
      return (
        item != null &&
        !item.deleted &&
        item.content instanceof Y.ContentType &&
        item.content.type instanceof Y.XmlElement
      );
    };
    if (!live(clientId + LIMINAL_BASE) && !live(clientId)) return null;
    return deref(doc, pointer);
  } catch {
    return null;
  }
}

export function deref<T extends AllowedYJSValue>(
  doc: Y.Doc,
  pointer: AllowedYValue | undefined,
  contextualDocumentId?: string, // only used for dependency docs internals
): T {
  if (pointer == null) {
    return null as T;
  }
  if (typeof pointer !== "object") {
    return pointer as T;
  }

  if (!isTupleReference(pointer)) {
    // Not a reference (e.g. a Uint8Array binary val) — return as-is.
    return pointer as T;
  }

  const entityId = pointer[0];

  const alteredDocumentId = pointer[1] ?? contextualDocumentId;
  if (alteredDocumentId) {
    return docPlexus.get(doc)!.getDependencyEntity(alteredDocumentId, entityId) as T;
  }

  // Entity cache check first — O(1) if already resolved
  const entityCache = documentEntityCaches.get(doc);
  const knownEntity = entityCache.get(entityId)?.deref();
  if (knownEntity) {
    return knownEntity as T;
  }

  // CRDT-native UUID → StructStore resolution — O(log n)
  // decode reverses the Feistel cipher to recover {clientId, clock},
  // then getItem does a binary search in the StructStore.
  const { clientId, clock } = decode(entityId as PlexusUUID);
  // Liminal-UUID resolution strategy: a struct minted in a liminal session is
  // promoted from the liminal base to the committed (materialized) base on commit,
  // but the UUID still encodes the liminal id. Try the materialized base first, fall
  // back to the liminal base; take the first existing. (genesis/regular UUIDs are
  // never promoted, so they resolve directly.)
  const item = isLiminalClientId(clientId)
    ? (resolveItem(doc, clientId + LIMINAL_BASE, clock) ?? resolveItem(doc, clientId, clock))
    : Y.getItem(doc.store, Y.createID(clientId, clock));
  invariant(
    item != null && item.content instanceof Y.ContentType,
    `Plexus<model#${entityId}>: decoded item is not a ContentType (got ${item?.content?.constructor?.name})`,
  );
  const entityModel = item.content.type as YPlexusNode;

  invariant(
    entityModel instanceof Y.XmlElement,
    `Plexus<model#${entityId}>: decoded item content is not XmlElement (got ${entityModel?.constructor?.name})`,
  );

  const targetType = entityModel.nodeName;
  invariant(typeof targetType === "string", `Plexus<model#${entityId}>: missing type (nodeName)`);

  const ModelConstructor = entityClasses.get(targetType) as ConcretePlexusConstructor;
  invariant(ModelConstructor, `Plexus<${targetType}#${entityId}>: class not registered in entityClasses`);

  const model = PlexusModel.__materializeRaw__(ModelConstructor);
  const internals = getInternals(model);
  invariant(
    !internals.isDependency,
    `Plexus<${targetType}#${entityId}>: raw materialization spawned dependency — bug in Plexus`,
  );
  internals.uuid = entityId as PlexusUUID;
  internals.yjsModel = new PlexusWrapper(entityModel);
  entityCache.set(entityId, new WeakRef(model));

  // Resolve parent from YJS wrapper BEFORE bootstrap.
  // Parent is always cached already (top-down materialization from root),
  // so this deref is a cache hit. Setting parent on internals ensures
  // informAdoptionSymbol's early-return fires during bootstrap,
  // avoiding [referenceSymbol] calls before docPlexus is registered.
  if (internals.yjsModel.hasParent) {
    internals.parent = deref(doc, [internals.yjsModel.parent!]);
    internals.parentKey = internals.yjsModel.parentKey;
    internals.parentMetadata = internals.yjsModel.parentMetadata;
  }

  model.__bootstrapObservation__();
  return model as T;
}
