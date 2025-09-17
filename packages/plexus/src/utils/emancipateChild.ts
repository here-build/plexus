import * as Y from "yjs";
import { LegitimateSchema, ParentReference } from "../proxy-runtime-types";
import { deref } from "../deref";
import invariant from "tiny-invariant";
import { maybeTransacting } from "./index";
import { PlexusModel } from "../PlexusModel";

export let currentlyEmancipating = new WeakSet<PlexusModel>();

export const emancipateChild = <T extends LegitimateSchema<T>>(
  doc: Y.Doc,
  child: PlexusModel,
  currentParentReference: ParentReference
) => {
  if (!currentParentReference) {
    return;
  }
  currentlyEmancipating.add(child);
  maybeTransacting(doc, () => {
    const [entityId, key, metadata] = currentParentReference;
    const parent = deref(doc, [entityId]) as PlexusModel;
    invariant(parent, `expected to see parent at ${entityId} but it's not there`);
    switch (parent._schema[key]) {
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
  currentlyEmancipating.delete(child);
};
