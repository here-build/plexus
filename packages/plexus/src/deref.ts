// Dereference both tuple and legacy object references

import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { documentEntityCaches } from "./entity-cache";
import { entityClasses } from "./globals";
import { getDependencyDoc } from "./plexus-registry";
import type { ConcretePlexusConstructor } from "./PlexusModel";
import { AllowedYJSValue, AllowedYValue, synthetic } from "./proxy-runtime-types";
import { isTupleReference } from "./utils";
import * as YJS_GLOBALS from "./YJS_GLOBALS";

export const deref = (doc: Y.Doc, pointer: AllowedYValue | undefined): AllowedYJSValue => {
  if (pointer == null) {
    return null;
  }
  if (typeof pointer !== "object") {
    return pointer;
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

  const targetEntityId = pointer[0];
  // Default to current project

  const targetType = doc
    .getMap<Y.Map<AllowedYJSValue>>(YJS_GLOBALS.models.key)
    ?.get(targetEntityId)
    ?.get(YJS_GLOBALS.models.recordFields.type) as string;
  invariant(targetType, `missing type for ${targetEntityId}`);

  const constructor = entityClasses.get(targetType) as ConcretePlexusConstructor;
  invariant(constructor, `missing constructor ${targetType} for ${targetEntityId}`);

  return documentEntityCaches.get(doc).get(targetEntityId)?.deref() ?? constructor[synthetic](targetEntityId, doc);
};
