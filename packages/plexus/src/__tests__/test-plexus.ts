import { nanoid } from "nanoid";
import * as Y from "yjs";
import { Plexus } from "../Plexus.js";
import type { PlexusModel } from "../PlexusModel.js";
import * as YJS_GLOBALS from "../YJS_GLOBALS.js";

/**
 * Test implementation of Plexus for testing purposes.
 * Provides simple dependency resolution from provided dependency docs.
 */
// @ts-expect-error - TestPlexus uses simplified types for testing
export class TestPlexus<Root extends PlexusModel> extends Plexus<Root> {
  private readonly availableDependencies: Map<string, () => Promise<Y.Doc>> = new Map();
  private cachedDependencies: Record<string, Y.Doc> = {};

  /**
   * Register a dependency factory for testing
   */
  registerDependencyFactory(dependencyId: string, factory: () => Promise<Y.Doc>) {
    this.availableDependencies.set(dependencyId, factory);
  }

  async fetchDependency(dependencyId: string, dependencyVersion?: string): Promise<Y.Doc> {
    // First check if we have a pre-created dependency doc
    let depDoc = this.cachedDependencies[dependencyId];

    // If not, try the factory
    if (!depDoc && this.availableDependencies.has(dependencyId)) {
      depDoc = await this.availableDependencies.get(dependencyId)!();
      this.cachedDependencies[dependencyId] = depDoc; // Cache it
    }

    if (!depDoc) {
      throw new Error(`Dependency "${dependencyId}" not found in test dependencies`);
    }

    // Always ensure the dependency doc has the correct documentId for cross-doc references
    const metadata = depDoc.getMap(YJS_GLOBALS.metadata.key);
    metadata.set(YJS_GLOBALS.metadata.wellKnown.documentId, dependencyId);

    return depDoc;
  }
}

/**
 * Initialize a TestPlexus with a new root entity.
 * This is the primary helper for tests - creates doc, bootstraps root, returns everything.
 */
export function initTestPlexus<Root extends PlexusModel>(
  rootEntity: Root,
  dependencies: Record<string, Y.Doc> = {},
  documentId?: string,
): { doc: Y.Doc; plexus: TestPlexus<Root>; root: Root } {
  const doc = new Y.Doc();

  // Set up metadata
  const metadata = doc.getMap(YJS_GLOBALS.metadata.key);
  metadata.set(YJS_GLOBALS.metadata.wellKnown.documentId, documentId ?? nanoid());

  // Bootstrap plexus with root
  const plexus = TestPlexus.bootstrap(rootEntity, doc, dependencies);

  return { doc, plexus, root: plexus.root as Root };
}

/**
 * Connect to an existing doc with TestPlexus.
 * Use when you have a doc that's already been synced/populated.
 */
export function connectTestPlexus<Root extends PlexusModel>(
  doc: Y.Doc,
  dependencies: Record<string, Y.Doc> = {},
): { plexus: TestPlexus<Root>; root: Root } {
  const plexus = TestPlexus.connect<Root>(doc, dependencies);
  return { plexus, root: plexus.root as Root };
}

/**
 * @deprecated Use connectTestPlexus instead. Async wrapper for backwards compatibility.
 */
export async function createTestPlexus<Root extends PlexusModel>(
  doc: Y.Doc,
  dependencies: Record<string, Y.Doc> = {},
): Promise<{ plexus: TestPlexus<Root>; root: Root }> {
  return connectTestPlexus<Root>(doc, dependencies);
}
