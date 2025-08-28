import * as Y from "yjs";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { load, docDependencyResolverMap, legitimateRootDocs } from "../load";
import { entityClasses } from "../globals";
import type { ModelPattern, Storageable } from "../proxy-runtime-types";
import { referenceSymbol } from "../proxy-runtime-types";
import invariant from "tiny-invariant";

/**
 * Test helpers to bootstrap docs with a root entity and dependencies.
 * These helpers allow tests to start from a predefined root state and then use load<T>(doc).
 */

/**
 * Register a doc as a legitimate plexus root and wire dependency resolver.
 */
export function primeDoc(doc: Y.Doc, dependencies: Record<string, Y.Doc> = {}) {
  legitimateRootDocs.add(doc);

  // Ensure base maps exist
  doc.getMap(YJS_GLOBALS.models);
  doc.getMap(YJS_GLOBALS.metadataMap);

  // Minimal resolver mirroring load() behavior for dependencies
  docDependencyResolverMap.set(doc, (entityId: string, packageId: string) => {
    const depDoc = dependencies[packageId];
    invariant(depDoc, `missing dependency doc for package ${packageId}`);

    const model = depDoc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(entityId);
    const type = model.get(YJS_GLOBALS.modelMetadataType) as string;
    invariant(model && type, `cannot find model data for ${packageId}:${entityId}`);
    const Constructor = entityClasses.get(type);
    invariant(Constructor, `cannot find model type ${type} for ${packageId}:${entityId}`);
    return Constructor.spawn(entityId, depDoc);
  });
}

/**
 * Materialize the provided entity into doc and mark it as the root.
 * Assumes the doc was primed via primeDoc().
 */
export function storeAsRoot(doc: Y.Doc, root: ModelPattern) {
  const [rootId] = (root as any)[referenceSymbol](doc);
  const metadata = doc.getMap<string>(YJS_GLOBALS.metadataMap);
  metadata.set(YJS_GLOBALS.metadataMapFields.root, rootId);
}

/**
 * Convenience: prime a doc, set given entity as root, and return loaded root.
 */
export function initDocWithRoot<T extends ModelPattern>(
  root: T,
  dependencies: Record<string, Y.Doc> = {}
) {
  const doc = new Y.Doc();
  primeDoc(doc, dependencies);
  const [rootId] = (root as any)[referenceSymbol](doc);
  const metadata = doc.getMap<string>(YJS_GLOBALS.metadataMap);
  metadata.set(YJS_GLOBALS.metadataMapFields.root, rootId);
  const loaded = load<T>(doc, dependencies);
  return { doc, root: loaded };
}

