// Dereference both tuple and legacy object references
// eslint-disable-next-line sonarjs/function-return-type
import * as Y from "yjs";
import type { AllowedYJSValue, AllowedYValue } from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { entityClasses } from "./globals";
import { isTupleReference } from "./utils";
import { docDependencyResolverMap } from "./load";

export const deref = (doc: Y.Doc, pointer: AllowedYValue): AllowedYJSValue => {
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
    return docDependencyResolverMap.get(doc)!(pointer[0], pointer[1]);
  }

  const targetEntityId = pointer[0];
  // Default to current project

  const targetType = doc.getMap<Y.Map<AllowedYJSValue>>(YJS_GLOBALS.models)?.get(targetEntityId)?.get(YJS_GLOBALS.modelMetadataType) as string;
  invariant(targetType, `missing type for ${targetEntityId}`);

  const constructor = entityClasses.get(targetType);
  invariant(constructor, `missing constructor ${targetType} for ${targetEntityId}`);

  return constructor.spawn(targetEntityId, doc);
};
