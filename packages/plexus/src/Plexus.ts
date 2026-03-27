/**
 * Plexus Document - Orchestrates YJS document state and undo/redo
 */

import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { ReadonlyDeep } from "type-fest";
import * as Y from "yjs";
import { UndoManager } from "yjs";

import { type DecodedBlob, decodeBlob, createBlobFromDoc } from "./dependency-blob.js";
import { deref } from "./deref.js";
import { documentEntityCaches } from "./entity-cache.js";
import { declareDeterministicMap, GENESIS_BASE, isGenesisClientId } from "./genesis-client.js";
import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { getInternals, PlexusModel, type PlexusConstructor } from "./PlexusModel.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYValue, PlexusUUID, YPlexusNode } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { maybeTransacting } from "./utils/utils.js";
import { getDependenciesMap, getMetaMap, getModelTypesMap } from "./yjs/getModels.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";
// MAX_UINT32 threshold: used for genesis Item filtering in UndoManager.
const MAX_UINT32 = 0xff_ff_ff_ff;

export class Plexus<Root extends PlexusModel<null> & { dependencies?: Record<string, Root> }> {
  /** Enable PLEXUS_TEST_SENTINEL — constructor throws the sentinel symbol for reachability testing. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  public static testSentinels: boolean = false;

  /** Set during controlled construction (sentinel-driven). Read by decorators init() to skip field initialization. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  static __isControlledConstruction__: boolean = false;

  /** Override in tests for deterministic UUIDs. Only used when PLEXUS_UUID_MODE=arbitrary. */
  // eslint-disable-next-line sonarjs/public-static-readonly
  public static uuidMode: "arbitrary" | undefined = (() => {
    try {
      return process.env.PLEXUS_UUID_MODE as "arbitrary" | undefined;
    } catch {
      return;
    }
  })();
  // eslint-disable-next-line sonarjs/public-static-readonly
  public static getArbitraryUUID: () => string = nanoid;
  readonly rootDependenciesRepresentation: ReadonlyDeep<Record<string, Root>> = new Proxy(
    {},
    {
      ownKeys: () => [...this.yDependencies.keys()],
      get: (_, key: string) => {
        if (typeof key !== "string") return;
        const blob = this.yDependencies.get(key);
        if (!blob) return;
        const decoded = this.#decodedBlobs.get(key);
        if (!decoded) return;
        return this.#materializeDependencyEntity(key, decoded.rootUuid);
      },
      getOwnPropertyDescriptor: (_, key: string) => {
        if (typeof key !== "string" || !this.yDependencies.has(key)) return;
        return { configurable: true, enumerable: true, value: (this.rootDependenciesRepresentation as any)[key] };
      },
    },
  );
  protected readonly yDependencies: Y.Map<Uint8Array>;

  readonly #decodedBlobs = new Map<string, DecodedBlob>();
  readonly #dependencyEntityCache = new Map<string, PlexusModel>();

  #ensureDecoded(projectId: string): DecodedBlob {
    let decoded = this.#decodedBlobs.get(projectId);
    if (!decoded) {
      const blob = this.yDependencies.get(projectId);
      invariant(blob, `Plexus: dependency "${projectId}" not loaded`);
      decoded = decodeBlob(blob);
      this.#decodedBlobs.set(projectId, decoded);
    }
    return decoded;
  }

  #materializeDependencyEntity(projectId: string, entityUuid: string): PlexusModel {
    const cacheKey = `${projectId}\0${entityUuid}`;
    const cached = this.#dependencyEntityCache.get(cacheKey);
    if (cached) return cached;

    const decoded = this.#ensureDecoded(projectId);
    const entry = decoded.entities.get(entityUuid);
    invariant(entry, `Plexus: entity "${entityUuid}" not found in dependency "${projectId}"`);

    const constructor = entityClasses.get(entry.type);
    invariant(
      constructor,
      `Plexus<dep#${projectId}, model#${entityUuid}> cannot discover model constructor "${entry.type}"`,
    );

    const self = this;
    const model = PlexusModel.__materializePredefined__(
      constructor as Extract<typeof constructor, new (...args: any) => any>,
      {
        isDependency: true,
        documentId: entry.sourceProjectId ?? projectId,
        uuid: entityUuid as PlexusUUID,
        get parent() {
          return entry.parentUuid ? self.#materializeDependencyEntity(projectId, entry.parentUuid) : null;
        },
        reference: [entityUuid, entry.sourceProjectId ?? projectId],
        parentKey: null,
        parentMetadata: null,
      },
    );

    // Lazy field hydration with deref for cross-doc reference resolution
    const fieldCache: Record<string, unknown> = {};
    const resolveProjectId = entry.sourceProjectId ?? projectId;
    Object.defineProperties(
      model,
      Object.fromEntries(
        Object.entries(model.__schema__).map(([key, type]): [string, PropertyDescriptor] => {
          const value = entry.attributes[key];
          switch (type) {
            case "val":
            case "child-val":
              return [
                key,
                {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    fieldCache[key] ??=
                      value == null ? null : deref(this.doc, value as AllowedYValue, resolveProjectId);
                    return fieldCache[key];
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
                    fieldCache[key] ??= value
                      ? (value as AllowedYValue[]).map((v) => deref(this.doc, v, resolveProjectId))
                      : [];
                    return fieldCache[key];
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
                    fieldCache[key] ??= value
                      ? new Set((value as AllowedYValue[]).map((v) => deref(this.doc, v, resolveProjectId)))
                      : new Set();
                    return fieldCache[key];
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
                    fieldCache[key] ??= value
                      ? Object.fromEntries(
                          Object.entries(value as Record<string, AllowedYValue>).map(([k, v]) => [
                            k,
                            deref(this.doc, v, resolveProjectId),
                          ]),
                        )
                      : {};
                    return fieldCache[key];
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
                    fieldCache[key] ??= value
                      ? new Map(
                          Object.entries(value as Record<string, AllowedYValue>).map(([k, v]) => [
                            k,
                            deref(this.doc, v, resolveProjectId),
                          ]),
                        )
                      : new Map();
                    return fieldCache[key];
                  },
                },
              ];
          }
        }),
      ),
    );

    this.#dependencyEntityCache.set(cacheKey, model);
    return model;
  }
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
    // Genesis clientIds live in the 0x1F namespace (>= GENESIS_BASE = 31 × 2^40).
    // Liminal clientIds (0x01 namespace, [2^32, 2^33)) are NOT stripped — committed
    // liminal changes are user decisions that must survive undo/redo.
    this.__undoManager__.on("stack-item-added", (event) => {
      const clients = event.stackItem.insertions.clients;
      for (const clientId of clients.keys()) {
        if (isGenesisClientId(clientId)) {
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

  addDependency(projectId: string, blob: Uint8Array): Root {
    invariant(
      Object.hasOwn(this.root, "dependencies"),
      `Plexus<document#${this.doc.clientID}>.addDependency: root model does not support dependencies`,
    );
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      !dependencies.has(projectId),
      `Plexus<document#${this.doc.clientID}>.addDependency: dependency "${projectId}" already exists`,
    );

    // Auto-detect format: if it's a Y.Doc state vector, convert to blob
    const finalBlob = this.#ensureBlobFormat(projectId, blob);

    maybeTransacting(this.doc, () => {
      dependencies.set(projectId, finalBlob);
    });

    const decoded = this.#ensureDecoded(projectId);
    return this.#materializeDependencyEntity(projectId, decoded.rootUuid) as Root;
  }

  replaceDependency(projectId: string, blob: Uint8Array): Root {
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      dependencies.has(projectId),
      `Plexus<document#${this.doc.clientID}>.replaceDependency: dependency "${projectId}" not found`,
    );

    const finalBlob = this.#ensureBlobFormat(projectId, blob);

    // Invalidate caches
    this.#decodedBlobs.delete(projectId);
    for (const key of this.#dependencyEntityCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        this.#dependencyEntityCache.delete(key);
      }
    }

    maybeTransacting(this.doc, () => {
      dependencies.set(projectId, finalBlob);
    });

    const decoded = this.#ensureDecoded(projectId);
    return this.#materializeDependencyEntity(projectId, decoded.rootUuid) as Root;
  }

  /**
   * Remove a dependency. References become dangling (deref throws).
   */
  removeDependency(projectId: string): void {
    const dependencies = getDependenciesMap(this.doc);
    invariant(
      dependencies.has(projectId),
      `Plexus<document#${this.doc.clientID}>.removeDependency: dependency "${projectId}" not found`,
    );

    // Invalidate caches
    this.#decodedBlobs.delete(projectId);
    for (const key of this.#dependencyEntityCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        this.#dependencyEntityCache.delete(key);
      }
    }

    maybeTransacting(this.doc, () => {
      dependencies.delete(projectId);
    });
  }

  public getDependencyEntity(projectId: string, entityUuid: string): PlexusModel {
    invariant(this.yDependencies.has(projectId), `Plexus: dependency "${projectId}" not loaded`);
    return this.#materializeDependencyEntity(projectId, entityUuid);
  }

  #ensureBlobFormat(projectId: string, data: Uint8Array): Uint8Array {
    // Try to detect: blob format starts with version byte (1).
    // Y.Doc state vectors start with different bytes.
    // Simple heuristic: try decoding as blob first.
    try {
      decodeBlob(data);
      return data; // Already blob format
    } catch {
      // Not blob format — assume Y.Doc state vector, convert
      return this.#convertDocVectorToBlob(projectId, data);
    }
  }

  #convertDocVectorToBlob(projectId: string, stateVector: Uint8Array): Uint8Array {
    const depDoc = new Y.Doc({ guid: projectId });
    Y.applyUpdate(depDoc, stateVector);

    const depMeta = getMetaMap(depDoc);
    const rootUuid = depMeta.get(YJS_GLOBALS.meta.wellKnown.root);
    invariant(rootUuid, `Plexus: dependency "${projectId}" has no root in meta map`);

    return createBlobFromDoc(depDoc, rootUuid, getModelTypesMap, PlexusWrapper);
  }
}
