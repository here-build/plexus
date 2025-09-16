/**
 * Plexus Document - Orchestrates YJS, dependencies, and semantic awareness
 */

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { CrossProjectReferenceTuple, isProxyEntity, referenceSymbol, Storageable } from "./proxy-runtime-types";
import { Tagged } from "type-fest";
import invariant from "tiny-invariant";
import { PlexusAwareness } from "./awareness";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import { DefaultedMap, maybeTransacting, never } from "./utils";
import { documentEntityCaches, entityClasses } from "./globals";
import { RestrictedArray, RestrictedRecord, RestrictedSet } from "./load";
import { PlexusModel } from "./PlexusModel";

export type DependencyId = Tagged<string, "Plexus dependency id">;
export type DependencyVersion = Tagged<string, "Plexus dependency id">;
export const docDependencyResolverMap = new WeakMap<
  Y.Doc,
  (entityId: string, dependencyId: DependencyId) => PlexusModel
>();

export abstract class Plexus<
  Root extends PlexusModel &
    (
      | {}
      | {
          readonly dependencies: Set<PlexusModel>;
          readonly dependencyVersion?: Record<DependencyId, DependencyVersion>;
        }
    ),
  DependencyRootType extends PlexusModel | null = Root extends {
    readonly dependencies: Set<infer DependencyType>;
    [referenceSymbol](doc: Y.Doc): CrossProjectReferenceTuple;
  }
    ? DependencyType
    : null,
  DependencyIdType extends DependencyId = DependencyId,
  DependencyVersionType extends DependencyVersion = DependencyVersion
> {
  static docPlexus = new WeakMap<Y.Doc, Plexus<any, any, any, any>>();
  public readonly doc: Y.Doc;
  public readonly awareness: PlexusAwareness;
  public readonly rootPromise: Promise<Root>;
  private dependencyDocs = new Map<DependencyIdType, Y.Doc>(); // Maps dependency ID -> Y.Doc for load() function
  private dependencyVersions = new Map<DependencyIdType, DependencyVersionType>(); // Maps "id@version" -> Y.Doc for version tracking
  private isRootLoaded = false;

  protected constructor(doc: Y.Doc, awareness?: awarenessProtocol.Awareness) {
    invariant(!Plexus.docPlexus.has(doc), "cannot spawn multiple entities of Plexus for same doc");
    this.doc = doc;
    Plexus.docPlexus.set(doc, this);
    this.awareness = new PlexusAwareness(awareness || new awarenessProtocol.Awareness(doc));
    // Defer loadRoot() to next tick to ensure child class is fully constructed
    this.rootPromise = Promise.resolve().then(() => this.loadRoot());
  }

  // Abstract method for fetching dependencies
  abstract fetchDependency(dependencyId: DependencyIdType, dependencyVersion?: DependencyVersionType): Promise<Y.Doc>;

  /**
   * Add a dependency to this Plexus document.
   * Automatically fetches the dependency, updates version tracking, and adds to root dependencies array.
   */
  async addDependency<T extends DependencyRootType>(
    dependencyId: DependencyIdType,
    dependencyVersion: DependencyVersionType
  ): Promise<T> {
    const root = await this.rootPromise;
    invariant("dependencies" in root, `Root entity does not support dependencies - missing 'dependencies' field`);
    invariant(
      "dependencyVersion" in root,
      `Root entity does not support dependencies - missing 'dependencyVersion' field`
    );
    // todo should stop the world when we have this feature? maybe
    const depDoc = await this.fetchDependency(dependencyId, dependencyVersion);
    this.dependencyDocs.set(dependencyId, depDoc);
    this.dependencyVersions.set(dependencyId, dependencyVersion);

    // Get dependency resolver and create dependency manifestation
    const resolver = docDependencyResolverMap.get(this.doc);
    invariant(resolver, "Missing dependency resolver for document");

    // Get the dependency root entity
    const depRootId = depDoc.getMap<string>(YJS_GLOBALS.metadataMap)?.get(YJS_GLOBALS.metadataMapFields.root);
    invariant(depRootId, "Dependency document missing root");

    const depRoot = resolver(depRootId, dependencyId) as T;
    invariant(depRoot, `cannot find root by ID ${depRootId} in dependency ${dependencyId}@${dependencyVersion}`);

    // Update root entity with new dependency
    const dependencies = root.dependencies;
    const dependencyVersionMap = root.dependencyVersion as Record<DependencyIdType, DependencyVersionType>;

    dependencies.add(depRoot);
    dependencyVersionMap[dependencyId] = dependencyVersion;

    return depRoot;
  }

  /**
   * Update a dependency to a new version.
   * Fetches the new version and updates the root entity.
   */
  async updateDependency(
    dependency: Exclude<DependencyRootType, null>,
    newVersion: DependencyVersionType
  ): Promise<void> {
    const [_, dependencyId] = dependency[referenceSymbol](this.doc);
    const currentVersionId = this.dependencyVersions.get(dependencyId as DependencyIdType);
    if (currentVersionId === newVersion) {
      return;
    }
    const newDoc = await this.fetchDependency(dependencyId as DependencyIdType, newVersion);
    this.dependencyDocs.set(dependencyId as DependencyIdType, newDoc);
    // todo somehow notify everyone that entities have changed
  }

  protected async loadRoot(): Promise<Root> {
    // Load initial root to discover dependencies
    // initializing
    const cache = new DefaultedMap<string, Map<string, DependencyRootType>>(() => new Map());
    const resolver = (entityId: string, dependencyId: DependencyIdType) => {
      const cachedEntity = cache.get(dependencyId).get(entityId);
      if (cachedEntity) {
        return cachedEntity;
      }

      const model = this.dependencyDocs.get(dependencyId)?.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(entityId);
      invariant(model, `cannot find model data for ${dependencyId}:${entityId}`);
      const type = model.get(YJS_GLOBALS.modelMetadataType) as string;
      const Constructor = entityClasses.get(type);
      invariant(Constructor, `cannot find model type ${type} for ${dependencyId}:${entityId}`);
      const proxyTarget = {};

      const manifestation = new Proxy(proxyTarget as Exclude<DependencyRootType, null>, {
        get(target, key) {
          switch (key) {
            case "clone":
              return (newProperties?: Record<string, any>) => {
                // Clone the manifestation (not the raw proxyTarget snapshot)
                // @ts-expect-error generic types
                return clone(manifestation as any, newProperties);
              };
            case isProxyEntity:
              return true;
            case "constructor":
              return Constructor;
            case "uuid":
              return entityId;
            case referenceSymbol:
              return () => [entityId, dependencyId];
            default:
              return target[key];
          }
        },
        set() {
          return false;
        },
        defineProperty() {
          return false;
        },
        has(_, key) {
          return key === referenceSymbol || key === "uuid" || key === isProxyEntity || Reflect.has(proxyTarget, key);
        }
      });
      cache.get(dependencyId).set(entityId, manifestation);
      Object.assign(
        proxyTarget,
        Object.fromEntries(
          Object.entries(Constructor.schema).map(([key, type]) => {
            const target = model.get(key);
            switch (type) {
              case "val":
              case "child-val":
                return [
                  key,
                  Array.isArray(target) ? resolver(target[0], (target[1] as DependencyIdType) ?? dependencyId) : target
                ];
              case "set":
              case "child-set":
                invariant(
                  target instanceof Y.Array,
                  `expected array at ${dependencyId}:${entityId}:${key}, got ${typeof target}`
                );
                const values = target
                  .toArray()
                  .map((val) =>
                    Array.isArray(val) ? resolver(val[0], (val[1] as DependencyIdType) ?? dependencyId) : val
                  );
                const base = new Set(values);
                Object.setPrototypeOf(base, RestrictedSet.prototype);
                return [key, Object.freeze(base as unknown as RestrictedSet)];
              case "list":
              case "child-list":
                invariant(
                  target instanceof Y.Array,
                  `expected array at ${dependencyId}:${entityId}:${key}, got ${typeof target}`
                );
                return [
                  key,
                  Object.freeze(
                    new RestrictedArray(
                      ...target
                        .toArray()
                        .map((val) =>
                          Array.isArray(val) ? resolver(val[0], (val[1] as DependencyIdType) ?? dependencyId) : val
                        )
                    )
                  )
                ];
              case "record":
              case "child-record":
                invariant(
                  target instanceof Y.Map,
                  `expected record at ${dependencyId}:${entityId}:${key}, got ${typeof target}`
                );
                const entries = Array.from(target.entries());
                return [
                  key,
                  Object.freeze(
                    new RestrictedRecord(
                      Object.fromEntries(
                        entries.map(([k, val]) => [
                          k,
                          Array.isArray(val) ? resolver(val[0], (val[1] as DependencyIdType) ?? dependencyId) : val
                        ])
                      )
                    )
                  )
                ];
              default:
                never(type);
            }
          })
        )
      );
      return manifestation;
    };
    docDependencyResolverMap.set(this.doc, resolver as any); // intentional due to TS2345

    const rootId = this.doc.getMap<string>(YJS_GLOBALS.metadataMap).get(YJS_GLOBALS.metadataMapFields.root);
    invariant(rootId, "missing root model id");
    const rootModel = this.doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(rootId);
    invariant(rootModel, "missing root model description");
    const rootType = rootModel.get(YJS_GLOBALS.modelMetadataType) as string;
    const Constructor = entityClasses.get(rootType);
    invariant(Constructor, `missing constructor of ${rootType} for root entity`);

    // Resolve all dependencies if they exist
    if ("dependencyVersion" in rootModel) {
      await this.resolveDependencies(rootModel.dependencyVersion as Record<DependencyIdType, DependencyVersionType>);
    }
    rootModel.observeDeep(async () => {
      if ("dependencyVersion" in rootModel) {
        await this.resolveDependencies(rootModel.dependencyVersion as Record<DependencyIdType, DependencyVersionType>);
      }
    });

    const root = new Constructor([rootId, this.doc]) as any as Root; // we're unable to validate types against tests anyway, sadly
    this.isRootLoaded = true;
    return root;
  }

  protected async resolveDependencies(dependencies: Record<DependencyIdType, DependencyVersionType>): Promise<void> {
    const missingDependencies = (Object.entries(dependencies) as [DependencyIdType, DependencyVersionType][]).flatMap(
      ([dependencyId, dependencyVersion]) =>
        this.dependencyVersions.get(dependencyId) !== dependencyVersion
          ? [[dependencyId, dependencyVersion] as [DependencyIdType, DependencyVersionType]]
          : []
    );
    if (missingDependencies.length > 0) {
      // todo pause doc updates
      await Promise.all(
        missingDependencies.map(async ([dependencyId, dependencyVersion]) => {
          this.dependencyDocs.set(dependencyId, await this.fetchDependency(dependencyId, dependencyVersion));
          this.dependencyVersions.set(dependencyId, dependencyVersion);
        })
      );
    }
  }

  /**
   * Load an entity by ID from the main document.
   * REQUIRES: rootPromise to be resolved first.
   * Used for comments, copy-paste, direct navigation.
   */
  loadEntity<T extends PlexusModel>(entityId: string): T | null {
    invariant(this.isRootLoaded, "Cannot load entities before root is loaded. Await plexus.rootPromise first.");

    // Check cache first
    const cached = documentEntityCaches.get(this.doc).get(entityId)?.deref();
    if (cached) return cached as T;

    // Get from Y.Doc
    const modelData = this.doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(entityId);
    if (!modelData) return null;

    // Get constructor
    const type = modelData.get(YJS_GLOBALS.modelMetadataType) as string;
    const Constructor = entityClasses.get(type);
    invariant(Constructor, `Unknown entity type: ${type}`);

    // Spawn and return
    return new Constructor([entityId, this.doc]) as any as T;
  }

  /**
   * Check if an entity exists in the document.
   * REQUIRES: rootPromise to be resolved first.
   */
  hasEntity(entityId: string): boolean {
    invariant(this.isRootLoaded, "Cannot check entities before root is loaded. Await plexus.rootPromise first.");

    return this.doc.getMap(YJS_GLOBALS.models).has(entityId);
  }

  /**
   * Get all entity IDs of a specific type.
   * REQUIRES: rootPromise to be resolved first.
   */
  getEntityIds(typeName?: string): string[] {
    invariant(this.isRootLoaded, "Cannot list entities before root is loaded. Await plexus.rootPromise first.");

    const models = this.doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
    const ids: string[] = [];

    models.forEach((model, id) => {
      if (!typeName || model.get(YJS_GLOBALS.modelMetadataType) === typeName) {
        ids.push(id);
      }
    });

    return ids;
  }

  /**
   * Get entity type by ID.
   * REQUIRES: rootPromise to be resolved first.
   */
  getEntityType(entityId: string): string | null {
    invariant(this.isRootLoaded, "Cannot get entity type before root is loaded. Await plexus.rootPromise first.");

    const modelData = this.doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models).get(entityId);
    if (!modelData) return null;

    return modelData.get(YJS_GLOBALS.modelMetadataType) as string;
  }

  /**
   * Execute a function within a transaction.
   * Uses maybeTransacting which handles:
   * - YJS transaction wrapping
   * - Shadow sub-transactions (no-op for nested calls)
   * - Notification batching and flushing
   */
  transact<T>(fn: () => T): T {
    return maybeTransacting(this.doc, fn);
  }
}
