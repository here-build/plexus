// Dereference both tuple and legacy object references

import invariant from "tiny-invariant";
import * as Y from "yjs";

import { documentEntityCaches } from "./entity-cache.js";
import { entityClasses } from "./globals.js";
import type { ConcretePlexusConstructor } from "./PlexusModel.js";
import { getInternals, PlexusModel } from "./PlexusModel.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYJSValue, AllowedYValue, PlexusUUID, YPlexusNode } from "./proxy-runtime-types.js";
import { isTupleReference } from "./utils/utils.js";
import { docPlexus } from "./plexus-registry.js";
import { getModelsMap } from "./yjs/getModels.js";

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
    // Not a reference, return as-is
    return pointer;
  }

  const entityId = pointer[0];

  const alteredDocumentId = pointer[1] ?? contextualDocumentId;
  if (alteredDocumentId) {
    return docPlexus.get(doc)!.__getDependencyNode__(alteredDocumentId, entityId) as T;
  }

  const yModels = getModelsMap(doc);

  const entityModel = yModels?.get(entityId);
  invariant(entityModel, `Plexus<document#${doc.clientID}>: model #${entityId} not found`);

  const targetType = entityModel.nodeName;
  invariant(typeof targetType === "string", `Plexus<model#${entityId}>: missing type (nodeName)`);

  const ModelConstructor = entityClasses.get(targetType) as ConcretePlexusConstructor;
  invariant(ModelConstructor, `Plexus<${targetType}#${entityId}>: class not registered in entityClasses`);

  const entityCache = documentEntityCaches.get(doc);
  const knownEntity = entityCache.get(entityId)?.deref();
  if (knownEntity) {
    return knownEntity as T;
  }
  const model = PlexusModel.__materializeRaw__(ModelConstructor);
  const internals = getInternals(model);
  invariant(
    !internals.isDependency,
    `Plexus<${targetType}#${entityId}>: somehow, raw materialization spawned dependency. This should never happen and is bug in Plexus itself`,
  );
  internals.uuid = entityId as PlexusUUID;
  internals.yjsModel = new PlexusWrapper(entityModel);
  entityCache.set(entityId, new WeakRef(model));
  model.__bootstrapObservation__();
  return model as T;
}
