/**
 * Plexus Document - Orchestrates YJS document state and undo/redo
 */

import invariant from "tiny-invariant";
import * as Y from "yjs";
import { UndoManager } from "yjs";

import { deref } from "./deref.js";
import { documentEntityCaches } from "./entity-cache.js";
import { docPlexus } from "./plexus-registry.js";
import type { PlexusModel } from "./PlexusModel.js";
import type { ParentReference, Storageable } from "./proxy-runtime-types.js";
import { referenceSymbol } from "./proxy-runtime-types.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { maybeTransacting } from "./utils/utils.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";

export abstract class Plexus<Root extends PlexusModel<null>> {
  protected readonly yModels: Y.Map<Y.Map<Y.Map<Storageable> | string | ParentReference>>;
  private readonly __undoManager__: UndoManager;
  private __isUndoing__ = false;

  // noinspection JSUnusedLocalSymbols
  private constructor(
    public readonly doc: Y.Doc,
    public readonly root: Root,
  ) {
    invariant(!docPlexus.has(doc), `Plexus<document#${doc.clientID}>: already initialized, singleton violation`);
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
              const model = documentEntityCaches.get(doc).get(id)?.deref();
              invariant(model, `Plexus<model#${id}>: undo event for unregistered model`);

              if (notifiedTargets.has(model)) {
                continue;
              }
              notifiedTargets.add(model);

              if (change.action === "add") {
                const newMap = this.yModels.get(id)!;
                if (model.__internals__.yjsModel !== newMap) {
                  model.__internals__.isDematerialized = false;
                  // old maps are not preserved; we need to regenerate the component logic
                  model.__internals__.yjsModel = this.yModels.get(id)!;
                  model.__internals__.yjsFieldsMap = model.__internals__.yjsModel.get(
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
                model.__internals__.isDematerialized = true;
                for (const key of Object.keys(model.__schema__)) {
                  // it is only needed for fixing tests that crash on serialization - otherwise behavior is same as per-object definitions were solving constructor-only problem
                  delete model[key];
                }
                model.__internals__.unobserve?.();
                model.__internals__.yjsModel = undefined;
                model.__internals__.yjsFieldsMap = undefined;
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
  static connect<T extends Plexus<any>, Root extends PlexusModel>(
    this: new (doc: Y.Doc, root: Root) => T,
    doc: Y.Doc,
  ): T {
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
    return new this(doc, root);
  }

  /**
   * Bootstrap a new Y.Doc with the provided root entity.
   * Returns existing instance if one exists for this class.
   */
  static bootstrap<T extends Plexus<Root>, Root extends PlexusModel>(
    this: new (doc: Y.Doc, root: Root) => T,
    root: Root,
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
}
