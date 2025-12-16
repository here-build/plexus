/**
 * Plexus Document - Orchestrates YJS document state and undo/redo
 */

import { decoding, encoding } from "lib0";
import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { Constructor, ReadonlyDeep } from "type-fest";
import * as Y from "yjs";
import { UndoManager } from "yjs";

import { deref } from "./deref.js";
import { DefaultedWeakMap, documentEntityCaches } from "./entity-cache.js";
import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { PlexusModel } from "./PlexusModel.js";
import type { AllowedYValue, ParentReference, Storageable } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { DefaultedMap } from "./utils/defaulted-collections.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { maybeTransacting } from "./utils/utils.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";

export class Plexus<Root extends PlexusModel<null> & { dependencies?: ReadonlyDeep<Record<string, Root>> }> {
  protected readonly yModels: Y.Map<Y.Map<Y.Map<Storageable> | string | ParentReference>>;
  protected readonly yDependencies: Y.Map<Y.Map<Uint8Array>>;
  protected readonly dependencyReverseId = new WeakMap<Y.Map<Uint8Array>, string>();
  private readonly dependencyModels = new DefaultedWeakMap((map: Y.Map<Uint8Array>) => {
    const documentId = this.dependencyReverseId.get(map)!;
    const defaultedMap: DefaultedMap<string, PlexusModel> = new DefaultedMap((uuid: string) => {
      const decoder = decoding.createDecoder(map.get(uuid)!);
      const modelType = decoding.readVarString(decoder);
      const storage = decoding.readAny(decoder);
      const parentUuid = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : null;
      const constructor = entityClasses.get(modelType);
      invariant(constructor, `Plexus<doc#${documentId}, model#${uuid}> cannot discover model constructor ${modelType}`);

      const model = PlexusModel.__materializePredefined__(
        constructor as Extract<typeof constructor, new (...args: any) => any>,
        {
          isDependency: true,
          documentId,
          uuid,
          get parent() {
            return parentUuid ? defaultedMap.get(parentUuid) : null;
          },
          reference: [documentId, uuid],
        },
      );
      const cache: Record<string, unknown> = {};
      Object.defineProperties(
        model,
        Object.fromEntries(
          Object.entries(model.__schema__).map(([key, type]): [string, PropertyDescriptor] => {
            const value = storage[key];
            switch (type) {
              case "val":
              case "child-val":
                return [
                  key,
                  {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                      cache[key] ??= deref(this.doc, value, documentId);
                      return cache[key];
                    },
                  },
                ];
              case "list":
              case "child-list":
                return [
                  key,
                  {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                      cache[key] ??= value.map((record: AllowedYValue) => deref(this.doc, record, documentId));
                      return cache[key];
                    },
                  },
                ];
              case "set":
              case "child-set":
                return [
                  key,
                  {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                      cache[key] ??= new Set(value.map((record: AllowedYValue) => deref(this.doc, record, documentId)));
                      return cache[key];
                    },
                  },
                ];
              case "record":
              case "child-record":
                return [
                  key,
                  {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                      cache[key] ??= Object.fromEntries(
                        Object.entries(value).map(([subkey, record]) => [
                          subkey,
                          deref(this.doc, record as AllowedYValue, documentId),
                        ]),
                      );
                      return cache[key];
                    },
                  },
                ];
            }
          }),
        ),
      );
      return model;
    });
    return defaultedMap;
  });
  readonly rootDependenciesRepresentation: ReadonlyDeep<Record<string, Root>> = new Proxy(
    {},
    {
      ownKeys: () => [...this.yDependencies.keys()],
      get: (_, key: string) =>
        this.dependencyModels.get(this.yDependencies.get(key)!).get(YJS_GLOBALS.models.wellKnown.root),
    },
  );
  private readonly __undoManager__: UndoManager;
  private __isUndoing__ = false;

  // noinspection JSUnusedLocalSymbols
  protected constructor(
    public readonly doc: Y.Doc,
    public readonly root: Root,
  ) {
    invariant(!docPlexus.has(doc), `Plexus<document#${doc.clientID}>: already initialized, singleton violation`);
    docPlexus.set(doc, this);

    // Set up undo manager

    this.yModels = doc.getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(YJS_GLOBALS.models.key);
    this.yDependencies = this.doc.getMap<Y.Map<Uint8Array>>(YJS_GLOBALS.dependencies.key);
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
              const model = documentEntityCaches.get(doc).get(id)?.deref();
              invariant(model, `Plexus<model#${id}>: undo event for unregistered model`);
              const internals = model.__internals__;
              if (internals.isDependency) {
                continue; // very likely we should not do anything; yet, this assumption is not 100%
              }

              if (notifiedTargets.has(model)) {
                continue;
              }
              notifiedTargets.add(model);

              if (change.action === "add") {
                const newMap = this.yModels.get(id)!;
                if (internals.yjsModel !== newMap) {
                  internals.isDematerialized = false;
                  // old maps are not preserved; we need to regenerate the component logic
                  internals.yjsModel = this.yModels.get(id)!;
                  internals.yjsFieldsMap = internals.yjsModel.get(
                    YJS_GLOBALS.models.recordFields.fields,
                  ) as Y.Map<Storageable>;
                  model.__bootstrapObservation__();
                  // we don't know what exactly changed due to transaction compression
                  undoManagerNotifications.get(model.__yjsFieldsMap__!)?.({
                    keysChanged: new Set(Object.keys(model.__schema__)),
                  } as any);
                }
                continue;
              }
              if (change.action === "delete") {
                // todo we also need to de-materialize when node is removed from graph; yet, it's not fully clear how to track it
                internals.isDematerialized = true;
                for (const key of Object.keys(model.__schema__)) {
                  // it is only needed for fixing tests that crash on serialization - otherwise behavior is same as per-object definitions were solving constructor-only problem
                  delete model[key];
                }
                internals.unobserve?.();
                internals.yjsModel = undefined;
                internals.yjsFieldsMap = undefined;
              }
              // todo we may need to process "update" too
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
   * Connect to an existing Y.Doc that already has a root.
   * Returns existing instance if one exists for this class, otherwise creates new.
   * Doc must be synced before calling - if no root found, throws with helpful hint.
   */
  // it is bad to use Function; yet, it's impossible to use Constructor<> directly since constructor is protected.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  static connect<Root extends PlexusModel, T extends Plexus<Root>>(this: Function & { prototype: T }, doc: Y.Doc): T {
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc) as T | undefined;
    if (existing) {
      invariant(
        existing.constructor === this,
        `Plexus<document#${doc.clientID}>.connect: already bound to ${existing.constructor.name}`,
      );
      return existing;
    }

    const yModels = doc.getMap(YJS_GLOBALS.models.key);

    invariant(
      yModels.has(YJS_GLOBALS.models.wellKnown.root),
      `Plexus<document#${doc.clientID}>.connect: no root found, await sync first`,
    );

    const root = deref(doc, [YJS_GLOBALS.models.wellKnown.root]) as Root;
    return new (this as Constructor<T>)(doc, root);
  }

  /**
   * Bootstrap a new Y.Doc with the provided root entity.
   * Returns existing instance if one exists for this class.
   */
  static bootstrap<T extends Plexus<Root>, Root extends PlexusModel>(
    // it is bad to use Function; yet, it's impossible to use Constructor<> directly since constructor is protected.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    this: Function & { prototype: T },
    root: Root,
    documentId: string = nanoid(),
    doc: Y.Doc = new Y.Doc(),
  ): T {
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc) as T | undefined;
    if (existing) {
      invariant(
        existing.constructor === this,
        `Plexus<document#${doc.clientID}>.bootstrap: already bound to ${existing.constructor.name}`,
      );
      return existing;
    }
    doc.getMap(YJS_GLOBALS.metadata.key).set(YJS_GLOBALS.metadata.wellKnown.documentId, documentId);
    return new (this as Constructor<T>)(doc, root);
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

  /**
   * Load an entity by ID from the main document.
   * Used for comments, copy-paste, direct navigation.
   */
  loadEntity<T extends PlexusModel>(entityId: string): T | null {
    return deref(this.doc, [entityId]) as T | null;
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

  public __getDependencyNode__(dependencyId: string, elementUuid: string) {
    const dependency = this.yDependencies.get(dependencyId);
    invariant(dependency, `Plexus<doc#${dependencyId}> cannot resolve dependency by id`);
    return this.dependencyModels.get(dependency).get(elementUuid);
  }

  addDependency(dependencyVector: Uint8Array): Root {
    invariant(
      Object.hasOwn(this.root, "dependencies"),
      `Plexus<document#${this.doc.clientID}>.addDependency: root model does not support dependencies`,
    );
    const dependencyDoc = new Y.Doc();
    Y.applyUpdate(dependencyDoc, dependencyVector);
    const metadata = dependencyDoc.getMap(YJS_GLOBALS.metadata.key);
    const dependencyDocumentId = metadata.get(YJS_GLOBALS.metadata.wellKnown.documentId) as string;
    const models = dependencyDoc.getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(YJS_GLOBALS.models.key);
    const dependencies = this.doc.getMap<Y.Map<Uint8Array>>(YJS_GLOBALS.dependencies.key);
    invariant(
      !dependencies.has(dependencyDocumentId),
      `Plexus<document#${this.doc.clientID}>.addDependency: dependency ${dependencyDocumentId} already exists in document`,
    );

    const storage = new Y.Map<Uint8Array>();
    this.dependencyReverseId.set(storage, dependencyDocumentId);
    this.doc.transact(() => {
      dependencies.set(dependencyDocumentId, storage);
      for (const [key, model] of models.entries()) {
        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, model.get(YJS_GLOBALS.models.recordFields.type) as string);
        encoding.writeAny(encoder, (model.get(YJS_GLOBALS.models.recordFields.fields) as Y.Map<Storageable>).toJSON());
        const parentRef = model.get(YJS_GLOBALS.models.recordFields.parent);
        if (parentRef) {
          encoding.writeVarString(encoder, parentRef[0]);
        }
        storage.set(key, encoding.toUint8Array(encoder));
      }
    });

    return this.dependencyModels.get(storage).get(YJS_GLOBALS.models.wellKnown.root) as Root;
  }
}
