import * as Y from "yjs";
import { LegitimateSchema, ModelType, ParentReference } from "../proxy-runtime-types";
import { deref } from "../deref";
import invariant from "tiny-invariant";

export const orphanizeChild = <T extends LegitimateSchema<T>>(doc: Y.Doc, child: ModelType<T, string>, currentParentReference: ParentReference) => {
  if (!currentParentReference) {
    return;
  }
  doc.transact(() => {
    const [entityId, key, metadata] = currentParentReference;
    const parent = deref(doc, [entityId]) as ModelType<{}, string>;
    invariant(parent, `expected to see parent at ${entityId} but it's not there`);
    switch (parent.constructor.schema[key]) {
      case "child-val":
        parent[key] = null;
        return;
      case "child-set":
        parent[key].delete(child);
        return;
      case "child-list":
        const childIndex = (parent[key] as any[]).indexOf(child);
        if (childIndex !== -1) {
          (parent[key] as any[]).splice(childIndex, 1);
        }
        return;
      case "child-record":
        delete parent[key][metadata];
        return;
    }
  });
};
