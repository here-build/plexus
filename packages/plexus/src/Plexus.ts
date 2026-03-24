/**
 * Plexus Document - Orchestrates YJS document state and undo/redo
 */

import { decoding, encoding } from "lib0";
import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { ReadonlyDeep } from "type-fest";
import * as Y from "yjs";
import { UndoManager } from "yjs";

import { deref } from "./deref.js";
import { DefaultedWeakMap } from "@here.build/collections";
import { documentEntityCaches } from "./entity-cache.js";
import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { getInternals, PlexusModel, type PlexusConstructor } from "./PlexusModel.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYValue, PlexusUUID, YPlexusNode } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { DefaultedMap } from "@here.build/collections";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { maybeTransacting } from "./utils/utils.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";
import { declareDeterministicMap } from "./genesis-client.js";
// MAX_UINT32 threshold: genesis clientIds are always above this value.
// Used to filter container genesis Items from UndoManager StackItems.
const MAX_UINT32 = 0xffffffff;
import { getDependenciesMap, getMetaMap, getModelTypesMap } from "./yjs/getModels.js";

export class Plexus<Root extends PlexusModel<null> & { dependencies?: Record<string, Root> }> {
  /** Enable PLEXUS_TEST_SENTINEL — constructor throws the sentinel symbol for reachability testing. */
  public static testSentinels: boolean = false;

  /** Set during controlled construction (sentinel-driven). Read by decorators init() to skip field initialization. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  static __isControlledConstruction__: boolean = false;

  /** Override in tests for deterministic UUIDs. Only used when PLEXUS_UUID_MODE=arbitrary. */
  public static uuidMode: "arbitrary" | undefined = (() => {
    try {
      return process.env.PLEXUS_UUID_MODE as "arbitrary" | undefined;
    } catch {
      return undefined;
    }
  })();
  public static getArbitraryUUID: () => string = nanoid;
  readonly rootDependenciesRepresentation: ReadonlyDeep<Record<string, Root>> = new Proxy(
    {},
    {
      ownKeys: () => [...this.yDependencies.keys()],
      get: (_, key: string) => {
        const depMap = this.yDependencies.get(key);
        if (!depMap) return undefined;
        // Find root UUID from the dependency's meta map
        const depDoc = new Y.Doc({ guid: key });
        // Dependencies are serialized — root is stored under the "root" well-known key
        // In old format, root was stored with key "root". In new format, we look in meta.
        // For dependencies, the root UUID is stored as the "root" key in the dependency map itself.
        const rootUuid = this.#findDependencyRoot(depMap);
        return this.dependencyModels.get(depMap).get(rootUuid);
      },
    },
  );
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
          reference: [uuid, documentId],
          parentKey: null,
          parentMetadata: null,
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
              case "map":
              case "child-map":
                return [
                  key,
                  {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                      cache[key] ??= new Map(
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
  protected readonly yTypes: Y.Map<Y.Map<YPlexusNode>>;
  private readonly __undoManager__: UndoManager;
  private __isUndoing__ = false;

  // noinspection JSUnusedLocalSymbols
  protected constructor(
    public readonly doc: Y.Doc,
    public readonly root: Root,
  ) {
    invariant(!docPlexus.has(doc), `Plexus<document#${doc.clientID}>: already initialized, singleton violation`);
    docPlexus.set(doc, this);

    // Set up type-scoped storage
    this.yTypes = getModelTypesMap(doc);
    this.yDependencies = getDependenciesMap(doc);

    // Mark root and materialize
    const rootInternals = getInternals(root);
    rootInternals.isRoot = true;
    // materialization of root should be explicitly done before UndoManager is spawned - otherwise we may accidentally
    // drop root during undos
    root[referenceSymbol](doc);
    // Store root pointer and encoding guid in meta map for remote peer discovery
    const meta = getMetaMap(doc);
    meta.set(YJS_GLOBALS.meta.wellKnown.root, rootInternals.uuid!);

    // Pre-create type sub-maps for ALL registered entity types BEFORE UndoManager connects.
    // Uses genesis clientIds (deterministic, conflict-free across independent peers).
    // Must happen before UndoManager so undo only removes entities, not type sub-maps.
    for (const type of entityClasses.keys()) {
      declareDeterministicMap(doc, [YJS_GLOBALS.types.key, type]);
    }

    this.__undoManager__ = new UndoManager(this.yTypes, {
      captureTimeout: 500,
      trackedOrigins: new Set([Plexus]),
    });

    // Strip genesis Items from UndoManager StackItems.
    // Genesis clientIds are always > MAX_UINT32 (entity genesis + container genesis).
    // Container creation is structural — must survive undo/redo, same as entities.
    this.__undoManager__.on("stack-item-added", (event) => {
      const clients = event.stackItem.insertions.clients;
      for (const clientId of clients.keys()) {
        if (clientId > MAX_UINT32) {
          clients.delete(clientId);
        }
      }
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
          // Skip outer types map events (type sub-map added/removed)
          if (evt.target === this.yTypes) {
            continue;
          }
          // Type sub-map event — entity added/deleted within a type
          if (evt.target instanceof Y.Map && evt.target !== this.yTypes) {
            for (const [id, change] of evt.changes.keys.entries()) {
              const model = documentEntityCaches.get(doc).get(id)?.deref();
              if (!model) continue; // Entity may not be cached yet (e.g. from remote peer)
              const internals = getInternals(model);
              if (internals.isDependency) {
                continue; // very likely we should not do anything; yet, this assumption is not 100%
              }

              if (notifiedTargets.has(model)) {
                continue;
              }
              notifiedTargets.add(model);

              if (change.action === "add") {
                const newElement = (evt.target as Y.Map<YPlexusNode>).get(id)!;
                if (internals.yjsModel?.element !== newElement) {
                  internals.isDematerialized = false;
                  // old elements are not preserved; we need to regenerate the component logic
                  internals.yjsModel = new PlexusWrapper(newElement);
                  model.__bootstrapObservation__();
                  // we don't know what exactly changed due to transaction compression
                  undoManagerNotifications.get(newElement)?.({
                    attributesChanged: new Set(Object.keys(model.__schema__)),
                    childListChanged: true,
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
              }
              // todo we may need to process "update" too
            }
            continue;
          }
          // Forward events to the target's notification handler
          const target = evt.target;

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
  static connect(doc: Y.Doc) {
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc);
    if (existing) {
      invariant(
        existing.constructor === this,
        `Plexus<document#${doc.clientID}>.connect: already bound to ${existing.constructor.name}`,
      );
      return existing;
    }

    const meta = getMetaMap(doc);
    const rootUuid = meta.get(YJS_GLOBALS.meta.wellKnown.root);

    invariant(rootUuid, `Plexus<document#${doc.clientID}>.connect: no root found, await sync first`);

    const root = deref(doc, [rootUuid]) as PlexusModel;
    getInternals(root).isRoot = true;
    return new this(doc, root);
  }

  /**
   * Get all materialized instances of a given model type.
   * Uses the types/{type} sub-map directly — no separate type index needed.
   */
  getAllOfType<T extends PlexusModel>(constructor: PlexusConstructor<T>): T[] {
    const typeMap = this.yTypes.get(constructor.modelName);
    if (!typeMap) return [];
    return [...typeMap.keys()].map((uuid) => deref(this.doc, [uuid]) as T);
  }

  /**
   * Bootstrap a new Y.Doc with the provided root entity.
   * Returns existing instance if one exists for this class.
   */
  static bootstrap(root: PlexusModel, documentId: string = nanoid(), doc: Y.Doc = new Y.Doc({ guid: documentId })) {
    // Return existing instance if one exists for this class
    const existing = docPlexus.get(doc);
    if (existing) {
      invariant(
        existing.constructor === this,
        `Plexus<document#${doc.clientID}>.bootstrap: already bound to ${existing.constructor.name}`,
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

  /**
   * Find all instances of ParentClass whose `field` references `node`.
   * Supports all field types. Child fields early-return (ownership is exclusive).
   * Reference fields use WeakSet dedup and yield all matches.
   */
  *parentsOf<P extends PlexusModel>(node: PlexusModel, parentClass: PlexusConstructor<P>, field: string): Generator<P> {
    const fieldType = parentClass.schema[field];
    invariant(fieldType, `parentsOf: field "${field}" does not exist on ${parentClass.modelName}`);
    const candidates = this.getAllOfType(parentClass);

    switch (fieldType) {
      // ── Child fields: ownership exclusive, at most one parent ──
      case "child-val": {
        for (const c of candidates) {
          if ((c as any)[field] === node) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-list": {
        for (const c of candidates) {
          if (((c as any)[field] as any[]).includes(node)) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-set": {
        for (const c of candidates) {
          if (((c as any)[field] as Set<any>).has(node)) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-record": {
        for (const c of candidates) {
          if (Object.values((c as any)[field]).includes(node)) {
            yield c;
            return;
          }
        }
        break;
      }
      case "child-map": {
        for (const c of candidates) {
          for (const v of ((c as any)[field] as Map<any, any>).values()) {
            if (v === node) {
              yield c;
              return;
            }
          }
        }
        break;
      }

      // ── Reference fields: multiple parents possible, dedup via seen ──
      case "val": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if ((c as any)[field] === node && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "list": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (((c as any)[field] as any[]).includes(node) && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "set": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (((c as any)[field] as Set<any>).has(node) && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "record": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (Object.values((c as any)[field]).includes(node) && !seen.has(c)) {
            seen.add(c);
            yield c;
          }
        }
        break;
      }
      case "map": {
        const seen = new WeakSet<P>();
        for (const c of candidates) {
          if (seen.has(c)) continue;
          for (const v of ((c as any)[field] as Map<any, any>).values()) {
            if (v === node) {
              seen.add(c);
              yield c;
              break;
            }
          }
        }
        break;
      }
    }
  }

  addDependency(dependencyDocumentId: string, dependencyVector: Uint8Array): Root {
    invariant(
      Object.hasOwn(this.root, "dependencies"),
      `Plexus<document#${this.doc.clientID}>.addDependency: root model does not support dependencies`,
    );
    const dependencyDoc = new Y.Doc({ guid: dependencyDocumentId });
    Y.applyUpdate(dependencyDoc, dependencyVector);
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      !dependencies.has(dependencyDocumentId),
      `Plexus<document#${this.doc.clientID}>.addDependency: dependency ${dependencyDocumentId} already exists in document`,
    );

    const storage = new Y.Map<Uint8Array>();
    this.dependencyReverseId.set(storage, dependencyDocumentId);

    // Find root UUID from the dependency doc's meta map
    const depMeta = getMetaMap(dependencyDoc);
    const depRootUuid = depMeta.get(YJS_GLOBALS.meta.wellKnown.root);
    invariant(depRootUuid, `Plexus: dependency ${dependencyDocumentId} has no root in meta map`);

    this.doc.transact(() => {
      dependencies.set(dependencyDocumentId, storage);
      for (const [_, typeContainer] of getModelTypesMap(dependencyDoc)) {
        for (const [key, model] of typeContainer.entries()) {
          const encoder = encoding.createEncoder();
          encoding.writeVarString(encoder, model.nodeName);
          // Serialize field attributes (flat storage — fields are directly on XmlElement)
          const attributes = Object.fromEntries(
            Object.entries(model.getAttributes()).map(([k, v]) => [k, v instanceof Y.AbstractType ? v.toJSON() : v]),
          );
          encoding.writeAny(encoder, attributes);
          // Parent data is stored as a child XmlElement, not as an attribute
          const wrapper = new PlexusWrapper(model);
          if (wrapper.hasParent) {
            encoding.writeVarString(encoder, wrapper.parent!);
          }
          storage.set(key, encoding.toUint8Array(encoder));
        }
      }
    });

    return this.dependencyModels.get(storage).get(depRootUuid) as Root;
  }

  public __getDependencyNode__(dependencyId: string, elementUuid: string) {
    const dependency = this.yDependencies.get(dependencyId);
    invariant(dependency, `Plexus<doc#${dependencyId}> cannot resolve dependency by id`);
    return this.dependencyModels.get(dependency).get(elementUuid);
  }

  #findDependencyRoot(depMap: Y.Map<Uint8Array>): string {
    // Dependencies store entities as uuid→serialized. The root is the one whose
    // parent field is absent. For backwards compat, try "root" key first.
    if (depMap.has("root")) return "root";
    // Otherwise scan for the entry with no parent
    for (const [uuid] of depMap.entries()) {
      const decoder = decoding.createDecoder(depMap.get(uuid)!);
      decoding.readVarString(decoder); // modelType
      decoding.readAny(decoder); // storage
      const hasParent = decoding.hasContent(decoder);
      if (!hasParent) return uuid;
    }
    invariant(false, "Plexus: dependency has no root entity");
  }
}
