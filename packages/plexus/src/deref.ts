// Dereference both tuple and legacy object references

import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { documentEntityCaches } from "./entity-cache.js";
import { entityClasses } from "./globals.js";
import { getDependencyDoc } from "./plexus-registry.js";
import { ConcretePlexusConstructor, PlexusModel } from "./PlexusModel.js";
import { AllowedYJSValue, AllowedYValue, ParentReference, Storageable } from "./proxy-runtime-types.js";
import { isTupleReference } from "./utils/index.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";

export function deref<T extends AllowedYJSValue>(doc: Y.Doc, pointer: AllowedYValue | undefined): T {
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

  // cross-project reference
  if (pointer[1]) {
    // Get the dependency doc directly
    const depDoc = getDependencyDoc(doc, pointer[1]);
    invariant(depDoc, `No dependency doc found for ${pointer[1]} from doc clientID:${doc.clientID}`);

    // Recursively deref in the dependency doc (without the dependency ID)
    return deref(depDoc, [pointer[0]]);
  }

  const entityId = pointer[0];
  // Default to current project

  const entityModel = doc
    .getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(YJS_GLOBALS.models.key)
    ?.get(entityId);
  invariant(entityModel, `model #${entityId} do not exist`);

  const targetType = entityModel?.get(YJS_GLOBALS.models.recordFields.type);
  invariant(typeof targetType === "string", `missing type for ${entityId}`);

  const ModelConstructor = entityClasses.get(targetType) as ConcretePlexusConstructor;
  invariant(ModelConstructor, `missing constructor ${targetType} for ${entityId}`);

  const entityCache = documentEntityCaches.get(doc);
  const knownEntity = entityCache.get(entityId)?.deref();
  if (knownEntity) {
    return knownEntity as T;
  }
  const model = PlexusModel.__materializeRaw__(ModelConstructor);
  model.__internals__.uuid = entityId;
  model.__internals__.yjsModel = entityModel;
  entityCache.set(entityId, new WeakRef(model));
  model.__bootstrapObservation__();
  return model as T;
}
