// Dereference both tuple and legacy object references
// eslint-disable-next-line sonarjs/function-return-type
import * as Y from "yjs";
import type { AllowedYJSValue, AllowedYValue } from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { entityClasses } from "./globals";
import { isTupleReference } from "./utils";

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
  // New tuple format: [entityId] or [entityId, projectId]
  const targetEntityId = pointer[0];
  const projectId = doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.projectId)!;
  const targetProjectId = pointer[1] || projectId; // Default to current project
  const prefix = targetProjectId === projectId ? "" : `project:${projectId}:`;

  // todo switch to subdocs?
  const targetYProjectEntityType = doc.getMap<string>(`${prefix}${YJS_GLOBALS.modelTypes}`);
  const targetType = targetYProjectEntityType.get(targetEntityId);
  invariant(targetType, `missing type for ${targetProjectId}.${targetEntityId}`);

  const constructor = entityClasses.get(targetType);
  invariant(constructor, `missing constructor ${targetType} for ${targetProjectId}.${targetEntityId}`);

  return constructor.spawn(targetEntityId, targetProjectId, doc);
};
