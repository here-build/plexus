// Dereference both tuple and legacy object references

import invariant from "tiny-invariant";
import * as Y from "yjs";

import { documentEntityCaches } from "./entity-cache.js";
import { entityClasses } from "./globals.js";
import type { ConcretePlexusConstructor } from "./PlexusModel.js";
import { PlexusModel } from "./PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ParentReference, Storageable } from "./proxy-runtime-types.js";
import { isTupleReference } from "./utils/utils.js";
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

  const entityId = pointer[0];

  // Cross-dependency references should use DependencyResolver, not deref
  invariant(!pointer[1], `Plexus<ref#${entityId}>: cross-dependency refs must use DependencyResolver`);

  const yModels = doc.getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(YJS_GLOBALS.models.key);

  const entityModel = yModels?.get(entityId);
  invariant(entityModel, `Plexus<document#${doc.clientID}>: model #${entityId} not found`);

  const targetType = entityModel?.get(YJS_GLOBALS.models.recordFields.type);
  invariant(typeof targetType === "string", `Plexus<model#${entityId}>: missing type field`);

  const ModelConstructor = entityClasses.get(targetType) as ConcretePlexusConstructor;
  invariant(ModelConstructor, `Plexus<${targetType}#${entityId}>: class not registered in entityClasses`);

  const fieldsMap = entityModel.get(YJS_GLOBALS.models.recordFields.fields);
  invariant(fieldsMap, `Plexus<${targetType}#${entityId}>: missing fields map`);
  invariant(
    fieldsMap instanceof Y.Map,
    `Plexus<${targetType}#${entityId}>: fields map is ${fieldsMap.constructor.name}, expected Y.Map`,
  );

  const entityCache = documentEntityCaches.get(doc);
  const knownEntity = entityCache.get(entityId)?.deref();
  if (knownEntity) {
    return knownEntity as T;
  }
  const model = PlexusModel.__materializeRaw__(ModelConstructor);
  model.__internals__.uuid = entityId;
  model.__internals__.yjsModel = entityModel;
  model.__internals__.yjsFieldsMap = fieldsMap;
  entityCache.set(entityId, new WeakRef(model));
  model.__bootstrapObservation__();
  return model as T;
}
