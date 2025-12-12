/**
 * Plexus Document - Orchestrates YJS and dependencies
 */

import invariant from "tiny-invariant";
import * as Y from "yjs";
import { UndoManager } from "yjs";

import { deref } from "./deref.js";
import { docPlexus, sharedDependencyDocs, sharedDependencyVersions } from "./plexus-registry.js";
import { PlexusModel } from "./PlexusModel.js";
import type { ParentReference, Storageable } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { maybeTransacting } from "./utils/utils.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";
import { DefaultedWeakMap } from "./utils/defaulted-collections.js";

export type DependencyId = string;
export type DependencyVersion = string | number;

// Re-export from registry for backward compatibility
export { getDependencyDoc } from "./plexus-registry.js";

type GenericRootModel = PlexusModel<null> &
  (
    | {
        dependencies?: never;
      }
    | {
        readonly dependencies: Set<PlexusModel<null>>;
        readonly dependencyVersion?: Record<string, string | number>;
      }
  );

type RootModelDependencyId<T extends GenericRootModel> = T extends {
  readonly dependencyVersion: Record<infer R extends string, string | number>;
}
  ? R
  : never;

type RootModelDependencyVersion<T extends GenericRootModel> = T extends {
  readonly dependencyVersion: Record<string, infer R extends string | number>;
}
  ? R
  : never;

export abstract class Plexus<
  Root extends GenericRootModel,
  DependencyRootType extends PlexusModel<null> | never = Root extends {
    readonly dependencies: Set<infer DependencyType extends Root>;
  }
    ? DependencyType
    : never,
  DependencyIdType extends RootModelDependencyId<Root> = RootModelDependencyId<Root>,
  DependencyVersionType extends RootModelDependencyVersion<Root> = RootModelDependencyVersion<Root>,
> {
  static readonly __modelMapBinding__ = new DefaultedWeakMap((doc: Y.Doc) => new Map<string, PlexusModel>());
  protected readonly yModels: Y.Map<Y.Map<Y.Map<Storageable> | string | ParentReference>>;
  private readonly __undoManager__: UndoManager;
  private __isUndoing__ = false;

  // Use getters to access shared per-doc mappings
  private get dependencyDocs(): Map<DependencyIdType, Y.Doc> {
    return sharedDependencyDocs.get(this.doc) as Map<DependencyIdType, Y.Doc>;
  }

  private get dependencyVersions(): Map<DependencyIdType, DependencyVersionType> {
    return sharedDependencyVersions.get(this.doc) as Map<DependencyIdType, DependencyVersionType>;
  }

  // noinspection JSUnusedLocalSymbols
  private constructor(
    public readonly doc: Y.Doc,
    public readonly root: Root,
  ) {
    invariant(!docPlexus.has(doc), "Plexus per-doc singleton was misinitialized twice for same doc");
    docPlexus.set(doc, this);

    // Set up undo manager

    this.yModels = doc.getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(YJS_GLOBALS.models.key);
    root.__internals__.uuid = YJS_GLOBALS.models.wellKnown.root;
    // materialization of root should be explicitly done before UndoManager is spawned - otherwise we may accidentally
    // drop root during undos
    root[referenceSymbol](doc);
    this.__undoManager__ = new UndoManager(this.yModels, {
      captureTimeout: 500,
      trackedOrigins: new Set([Plexus]),
    });

    // Wire up undo/redo notification bridge
    const handler = this.__undoManager__.on("stack-item-popped", (event) => {
      if (!this.__isUndoing__) {
        return;
      }
      const notifiedTargets = new Set<PlexusModel | Y.AbstractType<any>>();
      for (const yEvents of event.changedParentTypes.values()) {
        // we have very specific issue here: when we're undo-ing the changeset that was including model materialization,
        // we have it deleted, too, leading to funky state.
        for (const evt of yEvents) {
          if (evt.target === this.yModels) {
            for (const [id, change] of evt.changes.keys.entries()) {
              const model = Plexus.__modelMapBinding__.get(doc).get(id);
              invariant(model, "???");

              if (notifiedTargets.has(model)) {
                continue;
              }
              notifiedTargets.add(model);

              if (change.action === "add") {
                const newMap = this.yModels.get(id)!;
                if (model.__internals__.yjsModel !== newMap) {
                  // old maps are not preserved; we need to regenerate the component logic
                  model.__internals__.yjsModel = this.yModels.get(id)!;
                  model.__internals__.yjsFieldsMap = model.__internals__.yjsModel.get(
                    YJS_GLOBALS.models.recordFields.fields,
                  ) as Y.Map<Storageable>;
                  model.__internals__.presyncBackingStorage = new Map(model.__internals__.backingStorage);
                  model.__bootstrapObservation__();
                  // we don't know what exactly changed due to transaction compression
                  undoManagerNotifications.get(model.__yjsFieldsMap__!)?.({
                    keysChanged: new Set(Object.keys(model.__schema__)),
                  } as any);
                }
                continue;
              }
              if (change.action === "delete") {
                model.__internals__.yjsModel = undefined;
                model.__internals__.yjsFieldsMap = undefined;
                // todo this has odd behaviors - we need to review child references in old storage here
                model.__internals__.backingStorage = model.__internals__.presyncBackingStorage;
              }
              if (change.action === "update") {
                debugger;
              }
            }
            continue;
          }
          // model roots
          const target = this.yModels.has(evt.target) ? evt.target.get("fields") : this.yModels.has(evt.target);

          if (!notifiedTargets.has(target)) {
            notifiedTargets.add(target);
            undoManagerNotifications.get(target)?.(evt);
          }
        }
      }
    });
    this.__undoManager__.on("stack-item-added", handler);
  }

  /**
   * Get the Plexus instance for a doc and class.
   * Returns undefined if no instance exists.
   */
  static getForDoc<T extends Plexus<any, any, any, any>>(
    this: abstract new (...args: any[]) => T,
    doc: Y.Doc,
  ): T | undefined {
    return docPlexus.get(doc) as T | undefined;
  }

  /**
   * Connect to an existing Y.Doc that already has a root.
   * Returns existing instance if one exists for this class, otherwise creates new.
   * Doc must be synced before calling - if no root found, throws with helpful hint.
   */
  static connect<T extends Plexus<any, any, any, any>, Root extends PlexusModel>(
    this: new (doc: Y.Doc, root: Root) => T,
    doc: Y.Doc,
  ): T {
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc) as T | undefined;
    if (existing) {
      invariant(
        existing.constructor === this,
        "Document passed already has plexus binding, but it uses different subclass of Plexus",
      );
      return existing;
    }

    const yModels = doc.getMap(YJS_GLOBALS.models.key);

    invariant(
      yModels.has(YJS_GLOBALS.models.wellKnown.root),
      "No root found in doc. Did you await initial sync before calling Plexus.connect()?",
    );

    const root = deref(doc, [YJS_GLOBALS.models.wellKnown.root]) as Root;
    return new this(doc, root);
  }

  /**
   * Bootstrap a new Y.Doc with the provided root entity.
   * Returns existing instance if one exists for this class.
   */
  static bootstrap<T extends Plexus<Root, any, any, any>, Root extends PlexusModel>(
    this: new (doc: Y.Doc, root: Root) => T,
    root: Root,
    doc: Y.Doc = new Y.Doc(),
  ): T {
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc) as T | undefined;
    if (existing) {
      invariant(
        existing.constructor === this,
        "Document passed already has plexus binding, but it uses different subclass of Plexus",
      );
      return existing;
    }
    return new this(doc, root);
  }

  undo() {
    if (this.__isUndoing__) {
      this.__undoManager__.undo();
    } else {
      this.__isUndoing__ = true;
      this.__undoManager__.undo();
      this.__isUndoing__ = false;
    }
  }

  redo() {
    if (this.__isUndoing__) {
      this.__undoManager__.redo();
    } else {
      this.__isUndoing__ = true;
      this.__undoManager__.redo();
      this.__isUndoing__ = false;
    }
  }

  // Abstract method for fetching dependencies (to be overridden by subclasses)
  fetchDependency(dependencyId: DependencyIdType, dependencyVersion?: DependencyVersionType): Promise<Y.Doc> {
    throw new Error("not implemented");
  }

  /**
   * Add a dependency to this Plexus document.
   * Automatically fetches the dependency, updates version tracking, and adds to root dependencies array.
   */
  async addDependency<T extends DependencyRootType>(
    dependencyId: DependencyIdType,
    dependencyVersion: DependencyVersionType,
  ): Promise<T> {
    invariant("dependencies" in this.root, `Root entity does not support dependencies - missing 'dependencies' field`);
    invariant(
      "dependencyVersion" in this.root,
      `Root entity does not support dependencies - missing 'dependencyVersion' field`,
    );
    const depDoc = await this.fetchDependency(dependencyId, dependencyVersion);
    return this.transact(() => {
      this.dependencyDocs.set(dependencyId, depDoc);
      this.dependencyVersions.set(dependencyId, dependencyVersion);

      // Use deref to materialize the dependency root entity
      const depRoot = deref(depDoc, [YJS_GLOBALS.models.wellKnown.root]) as T;
      invariant(depRoot, `cannot find root in dependency ${dependencyId}@${dependencyVersion}`);

      // Update root entity with new dependency
      const root = this.root as Root & {
        dependencies: Set<PlexusModel>;
        dependencyVersion: Record<string, DependencyVersion>;
      };
      root.dependencies.add(depRoot);
      root.dependencyVersion[dependencyId as string] = dependencyVersion as DependencyVersion;
      return depRoot;
    });
  }

  /**
   * Update a dependency to a new version.
   * Fetches the new version and updates the root entity.
   */
  async updateDependency(
    dependency: Exclude<DependencyRootType, null>,
    newVersion: DependencyVersionType,
  ): Promise<void> {
    const [, dependencyId] = dependency[referenceSymbol](this.doc);
    const currentVersionId = this.dependencyVersions.get(dependencyId as DependencyIdType);
    if (currentVersionId === newVersion) {
      return;
    }
    const newDoc = await this.fetchDependency(dependencyId as DependencyIdType, newVersion);
    this.dependencyDocs.set(dependencyId as DependencyIdType, newDoc);
    // todo somehow notify everyone that entities have changed
  }

  /**
   * Load an entity by ID from the main document.
   * Used for comments, copy-paste, direct navigation.
   */
  loadEntity<T extends PlexusModel>(entityId: string): T | null {
    return deref(this.doc, [entityId]) as T | null;
  }

  /**
   * Check if an entity exists in the document.
   */
  hasEntity(entityId: string): boolean {
    return this.yModels.has(entityId);
  }

  /**
   * Get all entity IDs of a specific type.
   */
  getEntityIds(typeName?: string): string[] {
    const models = this.yModels;
    const ids: string[] = [];

    for (const [id, model] of models.entries()) {
      if (!typeName || model.get(YJS_GLOBALS.models.recordFields.type) === typeName) {
        ids.push(id);
      }
    }

    return ids;
  }

  /**
   * Get entity type by ID.
   */
  getEntityType(entityId: string): string | null {
    const modelData = this.yModels.get(entityId);
    if (!modelData) return null;

    return modelData.get(YJS_GLOBALS.models.recordFields.type) as string;
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
