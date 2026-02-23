import "@here.build/arrival-env";
import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { Constructor, ReadonlyDeep } from "type-fest";
import * as Y from "yjs";

import { clone } from "./clone.js";
import { deref } from "./deref.js";
import { documentEntityCaches } from "./entity-cache.js";
import {
  PlexusCycleError,
  PlexusDependencyError,
  PlexusDocMismatchError,
  PlexusRootParentError,
  PlexusSelfAdoptionError,
} from "./errors.js";
import { docPlexus } from "./plexus-registry.js";
import { PlexusWrapper } from "./PlexusWrapper.js";
import { serializeKey } from "./proxies/materialized-map.js";
import {
  type AllowedYJSMapKey,
  type AllowedYJSValue,
  type AllowedYJSValueList,
  type AllowedYJSValueMap,
  type AllowedYJSValueSet,
  type AllowedYValue,
  type GenericRecordSchema,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  type Internals,
  materializationSymbol,
  type PlexusTagContainer,
  type PlexusUUID,
  referenceSymbol,
  type ReferenceTuple,
  requestAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
} from "./proxy-runtime-types.js";
import { trackAccess, trackModification } from "./tracking.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { curryMaybeReference, maybeTransacting, never } from "./utils/utils.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";
import { getModelsMap } from "./yjs/getModels.js";

export type PlexusConstructor<T extends PlexusModel = PlexusModel> = (abstract new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};
export type ConcretePlexusConstructor<T extends PlexusModel = PlexusModel> = (new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};

const currentlyEmancipating = new WeakSet<PlexusModel>();

const internalsStore = new WeakMap<PlexusModel, Internals<any>>();

/**
 * Access internals for a PlexusModel instance.
 * Parent type is recovered from the model's generic parameter.
 * Module-internal — not re-exported from index.ts.
 */
export function getInternals<Parent extends PlexusModel | null = any>(model: PlexusModel<Parent>): Internals<Parent> {
  return internalsStore.get(model) as Internals<Parent>;
}

// Helper type to detect if a property is readonly (getter)
type IfEquals<X, Y, A, B> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B;
type WritableKeys<T> = {
  [P in keyof T]: IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] }, P, never>;
}[keyof T];

export type PlexusInit<T extends PlexusModel> = {
  [key in keyof T as key extends keyof PlexusModel
    ? never
    : key extends WritableKeys<T>
      ? T[key] extends AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
        ? key
        : T[key] extends AllowedYJSValue
          ? null extends T[key]
            ? key
            : never
          : never
      : never]?: T[key];
} & {
  [key in keyof T as key extends keyof PlexusModel
    ? never
    : key extends WritableKeys<T>
      ? T[key] extends AllowedYJSValue
        ? null extends T[key]
          ? never
          : key
        : never
      : never]: T[key];
};

export abstract class PlexusModel<Parent extends PlexusModel | null = any> {
  // eslint-disable-next-line sonarjs/public-static-readonly
  static __isMaterializingRaw__ = false;
  // eslint-disable-next-line sonarjs/public-static-readonly
  static __forcedInternals__: Internals<any> | null = null;
  // eslint-disable-next-line sonarjs/public-static-readonly
  static modelName: string;
  static readonly schema: GenericRecordSchema;

  constructor(init: unknown = {}) {
    // Use forced internals if provided (for dependency models), otherwise default
    const internals: Internals<any> = PlexusModel.__forcedInternals__ ?? {
      parent: null,
      parentKey: null,
      parentMetadata: null,
      initializationState: init as any,
      isWithinYjsModelSeed: false,
      yjsModel: undefined,
      backingStorage: new Map<string, any>(),
    };
    internalsStore.set(this, internals);
    if (!PlexusModel.__forcedInternals__) {
      setTimeout(() => {
        // @ts-expect-error after we're bootstrapped, initializationState is not needed anymore
        internals.initializationState = null;
      });
    }
    Object.defineProperties(
      this,
      Object.fromEntries(
        Object.keys(this.__schema__).map((key) => {
          let prototype = (this as any).__proto__;
          while (prototype && prototype !== prototype.__proto__) {
            if (Object.hasOwn(prototype, key)) {
              break;
            }
            prototype = prototype.__proto__;
          }
          invariant(
            prototype,
            `Plexus<${(this.constructor as PlexusConstructor).modelName}>: schema field "${key}" not found in prototype chain`,
          );
          return [
            key,
            // this helps us auto-correct user's mistakes when instead of accessor declaration of schema field
            // prop declaration is used - this only happens in children of synced elements, thus, we just need to override
            // "wrong" field with its actual behavior.
            // this also makes all of them enumerable of course. examples of "why it's needed" are in inheritance tests
            {
              ...Object.getOwnPropertyDescriptor(prototype, key),
              enumerable: true,
              configurable: true,
            } satisfies PropertyDescriptor,
          ] as const;
        }),
      ),
    );
    return this as typeof this & PlexusTagContainer<this>;
  }

  get uuid(): PlexusUUID {
    if (this.__internals__.uuid) {
      return this.__internals__.uuid;
    }
    if (this.__internals__.isDependency) {
      return this.__internals__.uuid;
    }
    this.__internals__.uuid = nanoid() as PlexusUUID;
    this.__internals__.reference = [this.__internals__.uuid];
    Object.freeze(this.__internals__.reference);
    return this.__internals__.uuid;
  }

  static __materializeRaw__<T extends PlexusModel>(constructor: Constructor<T>) {
    PlexusModel.__isMaterializingRaw__ = true;
    try {
      return new constructor();
    } finally {
      PlexusModel.__isMaterializingRaw__ = false;
    }
  }

  get __doc__(): Y.Doc | null {
    invariant(
      !this.__internals__.isDependency,
      `Plexus<${this.__type__}#${this.uuid}>: dependency do not have __doc__`,
    );
    return this.__internals__.yjsModel?.doc ?? null;
  }

  get __schema__(): ReadonlyDeep<GenericRecordSchema> {
    return (this.constructor as PlexusConstructor).schema;
  }

  get __type__() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  get __yjsFieldsMap__(): PlexusWrapper | undefined {
    invariant(
      !this.__internals__.isDependency,
      `Plexus<${this.__type__}#${this.uuid}>: dependency do not have __wrapper__`,
    );
    return this.__internals__.yjsModel;
  }

  /**
   * Walk up parent chain to find root.
   * Returns root if reachable, null if detached or in cycle.
   * For root entity, returns this.
   */
  get rootAncestor(): PlexusModel<null> | null {
    if (this.isRoot) return this as unknown as PlexusModel<null>;
    if (!this.__doc__) return null;
    if (this.__internals__.isDependency) return null;

    const visited = new Set<PlexusModel>();
    let current: PlexusModel | null = this as PlexusModel;

    while (current) {
      if (visited.has(current)) return null; // Cycle detected
      visited.add(current);

      if (current.uuid === "root") {
        return current as PlexusModel<null>;
      }
      current = getInternals(current).parent;
    }

    return null; // Orphan
  }

  get parent(): Parent | null {
    trackAccess(this, "parent");
    return this.__internals__.parent;
  }

  /**
   * True if this is the root entity (uuid === "root")
   */
  get isRoot(): boolean {
    return this.uuid === "root";
  }

  /**
   * True if entity is materialized but not reachable from root.
   * Ephemeral (unmaterialized) entities are NOT detached.
   * Dependency entities are NOT detached.
   */
  get isDetached(): boolean {
    if (!this.__doc__) return false; // Ephemeral
    if (this.__internals__.isDependency) return false;
    if (this.isRoot) return false;
    return this.rootAncestor === null;
  }

  private get __internals__() {
    return getInternals(this);
  }

  get documentId(): string | undefined {
    return this.__doc__?.getMap(YJS_GLOBALS.metadata.key).get(YJS_GLOBALS.metadata.wellKnown.documentId) as
      | string
      | undefined;
  }

  static __materializePredefined__<T extends PlexusModel>(constructor: Constructor<T>, internals: Internals<any>) {
    PlexusModel.__isMaterializingRaw__ = true;
    PlexusModel.__forcedInternals__ = internals;
    try {
      return new constructor();
    } finally {
      PlexusModel.__isMaterializingRaw__ = false;
      PlexusModel.__forcedInternals__ = null;
    }
  }

  [requestEmancipationSymbol]() {
    this.#emancipate();
  }

  // noinspection JSUnusedGlobalSymbols
  toJSON() {
    return Object.fromEntries(Object.keys(this.__schema__).map((key) => [key, this[key]]));
  }

  [Symbol.SExpr](): string {
    return this.__type__;
  }

  /**
   * Validates adoption without modifying any state.
   * All checks that could throw must happen here BEFORE any state modification.
   * This prevents partial state modification when validation fails.
   * Uses custom error types with verbose console.error logging.
   */
  [validateAdoptionSymbol]<T extends Exclude<Parent, null>>(this: PlexusModel, newParent: T, field: string): void {
    const internals = this.__internals__;

    PlexusDependencyError.invariant(!internals.isDependency, this, "adopted");
    PlexusRootParentError.invariant(internals.uuid !== YJS_GLOBALS.models.wellKnown.root, this, newParent);
    PlexusSelfAdoptionError.invariant(newParent !== this, this, field);
    for (let cur: PlexusModel | null = newParent; cur; cur = getInternals(cur).parent) {
      PlexusCycleError.invariant(cur !== this, this, newParent, field, cur);
    }

    // Check 5: Doc mismatch check
    PlexusDocMismatchError.invariant(
      !newParent.__doc__ || !this.__doc__ || newParent.__doc__ === this.__doc__,
      this,
      newParent,
    );
  }

  /**
   * Updates parent pointers and YJS state for adoption.
   * IMPORTANT: Validation must be done via validateAdoptionSymbol BEFORE calling this.
   * This method assumes all validation has passed and only modifies state.
   */
  [informAdoptionSymbol]<T extends Exclude<Parent, null>>(newParent: T, field: string, extraFieldMetadata?: string) {
    const internals = this.__internals__;
    PlexusDependencyError.invariant(!internals.isDependency, this, "edited");
    if (
      internals.parent === newParent &&
      internals.parentKey === field &&
      internals.parentMetadata === extraFieldMetadata
    ) {
      return;
    }
    if (!internals.yjsModel && newParent.__doc__) {
      this[referenceSymbol](newParent.__doc__);
    }

    const oldParent = internals.parent;
    internals.parent = newParent;
    internals.parentKey = field;
    internals.parentMetadata = extraFieldMetadata ?? null;

    maybeTransacting(this.__doc__, () => {
      if (this.__doc__) {
        const reference = newParent[referenceSymbol](this.__doc__!);
        internals.yjsModel!.setParentData(reference[0], field, extraFieldMetadata);
      }
      if (oldParent !== newParent) {
        trackModification(this, "parent");
      }
    });
  }

  /**
   * Requests adoption of this entity by a new parent.
   * Validates, emancipates from old parent, then adopts to new parent.
   * CRITICAL: Validation happens BEFORE any state modification to prevent partial state on error.
   */
  [requestAdoptionSymbol]<T extends Exclude<Parent, null>>(newParent: T, field: string, extraFieldMetadata?: string) {
    const internals = this.__internals__;

    if (this.parent === newParent && internals.parentKey === field && internals.parentMetadata === extraFieldMetadata) {
      return;
    }

    this[validateAdoptionSymbol](newParent, field);
    this.#emancipate();
    this[informAdoptionSymbol](newParent, field, extraFieldMetadata);
  }

  [requestOrphanizationSymbol]() {
    this.#emancipate();
    this[informOrphanizationSymbol]();
  }

  [informOrphanizationSymbol]() {
    const internals = this.__internals__;

    PlexusDependencyError.invariant(!internals.isDependency, this, "orphaned");
    internals.parent = null;
    internals.parentKey = null;
    internals.parentMetadata = null;
    if (internals.yjsModel) {
      if (internals.yjsModel.hasParent) {
        maybeTransacting(this.__doc__, () => {
          internals.yjsModel!.clearParentData();
          trackModification(this, "parent");
        });
      }
    }
  }

  /**
   * Explicitly detach this entity from its parent.
   * Removes the entity from its parent's child container and nulls the parent pointer.
   *
   * This is useful for operations that need to temporarily disconnect entities,
   * such as node swapping or restructuring the tree.
   *
   * Its primary value is that it allows to not think about "where exactly this parent uses this child" as this
   * is sometimes quite tricky (and since it's using internal state, it's also faster)
   *
   * @returns true if entity was attached and is now detached, false if already detached
   *
   * @throws PlexusDependencyError if called on a dependency entity
   *
   * @example
   * ```typescript
   * // Swap two nodes by detaching first
   * const wasAttached = nodeB.detach();
   * if (wasAttached) {
   *   parent.childVal = nodeA;  // Now safe to replace
   * }
   * ```
   */
  detach(): boolean {
    if (this.parent === null) {
      return false;
    }
    this[requestOrphanizationSymbol]();
    return true;
  }

  clone<T extends PlexusModel>(this: T, newProps: Partial<Omit<T, keyof PlexusModel>> = {}): T {
    return clone(this, newProps);
  }

  // since full PlexusModel always represents only root doc (not dependencies), it's always local reference.
  [referenceSymbol](doc: Y.Doc): ReferenceTuple {
    const internals = this.__internals__;
    if (internals.isDependency) {
      return internals.reference;
    }
    invariant(docPlexus.has(doc), `Plexus<document#${doc.clientID}>: not registered as Plexus root`);
    const yModels = getModelsMap(doc);

    if (internals.yjsModel?.doc) {
      invariant(
        doc === internals.yjsModel.doc,
        `Plexus<${this.__type__}#${this.uuid}>: cannot cross-reference between docs`,
      );
      if (yModels.has(this.uuid)) {
        // you never know what kinds of interesting states you can get in with CRDT
        invariant(
          yModels.get(this.uuid) === internals.yjsModel.element,
          `Plexus<${this.__type__}#${this.uuid}>: uuid conflict, already taken by different model`,
        );
      } else {
        // this MAY and is allowed to happen during the undo operations that are removing some class from model;
        // this is weird situation where Y.XmlElement technically belongs to doc, but exists in pre-GC limbo.
        yModels.set(this.uuid, internals.yjsModel.element);
        internals.isDematerialized = false;
      }
      return this.#reference;
    }
    const boundMaybeReference = curryMaybeReference(doc);

    return maybeTransacting(doc, () => {
      let yprojectObjectInstance = yModels.get(this.uuid);
      internals.isWithinYjsModelSeed = true;
      if (!yprojectObjectInstance) {
        // type is encoded in XmlElement nodeName; fields stored directly as attributes (flat)
        yprojectObjectInstance = new Y.XmlElement(this.#type);
        yModels.set(this.uuid, yprojectObjectInstance);
        // yjsModel must be set before schema iteration to avoid circular self-reference issues
        internals.yjsModel = new PlexusWrapper(yprojectObjectInstance);
        internals.isDematerialized = false; // Clear if re-materializing after undo
        documentEntityCaches.get(doc).set(this.uuid, new WeakRef(this));
        // there may be instantation loops where we need to have internals.yjsModel materialized in that flow
        if (internals.parent) {
          const parentReference = internals.parent[referenceSymbol](doc);
          internals.yjsModel.setParentData(parentReference[0], internals.parentKey!, internals.parentMetadata);
        }
      } else if (internals.isDematerialized) {
        // Re-materialization of a dematerialized model (XmlElement exists but yjsModel was cleared)
        internals.yjsModel = new PlexusWrapper(yprojectObjectInstance);
        internals.isDematerialized = false;
      }
      const wrapper = internals.yjsModel!;
      for (const [schemaKey, type] of Object.entries(this.__schema__)) {
        switch (type) {
          case "val":
          case "child-val":
            wrapper.set(
              schemaKey,
              boundMaybeReference(internals.backingStorage.get(schemaKey) as AllowedYJSValue),
            );
            break;
          case "list":
          case "child-list":
            wrapper.set(
              schemaKey,
              // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
              Y.Array.from(
                // @ts-expect-error same issue
                // Convert sparse arrays to dense arrays (holes become null)
                Array.from<AllowedYJSValue, AllowedYValue>(this[schemaKey], boundMaybeReference),
              ),
            );
            break;
          case "record":
          case "child-record":
            wrapper.set(
              schemaKey,
              new Y.Map<AllowedYValue | null>(
                Object.entries(this[schemaKey] as Record<string, AllowedYJSValue>).map(([recordKey, val]) => [
                  recordKey,
                  boundMaybeReference(val),
                ]),
              ),
            );
            break;
          case "set":
          case "child-set":
            wrapper.set(
              schemaKey,
              // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
              Y.Array.from(
                // @ts-expect-error same issue
                Array.from(this[schemaKey], boundMaybeReference),
              ),
            );
            break;
          case "map":
          case "child-map": {
            // Map proxy uses PathMap for in-memory storage, serialize for Y.Map
            const mapProxy = this[schemaKey] as Map<AllowedYJSMapKey, AllowedYJSValue>;
            const entries: [string, AllowedYValue | null][] = [];
            for (const [key, val] of mapProxy.entries()) {
              // Use serializeKey to match materialized-map.ts format (Set:, Array:, Value: prefixes)
              const serializedKey = serializeKey(key, doc);
              entries.push([serializedKey, boundMaybeReference(val)]);
            }
            wrapper.set(schemaKey, new Y.Map<AllowedYValue | null>(entries));
            break;
          }
          default:
            never(type);
        }
      }
      this.__bootstrapObservation__();
      documentEntityCaches.get(doc).set(this.uuid, new WeakRef<PlexusModel>(this));
      internals.isWithinYjsModelSeed = false;
      return this.#reference;
    });
  }

  get #reference(): ReferenceTuple {
    return [this.uuid] as const;
  }

  get #type() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  __bootstrapObservation__() {
    const internals = this.__internals__;
    if (internals.isDependency) {
      return;
    }
    invariant(
      internals.yjsModel,
      `Plexus<${this.__type__}#${this.uuid}>: cannot bootstrap observation without wrapper`,
    );
    const element = internals.yjsModel.element;
    if (undoManagerNotifications.has(element)) {
      console.trace("(not-an-error) double-bootstrapping, may be reasonable to check whether optimization can be done");
      return;
    }
    // Initialize runtime parent from yjsModel's child XmlElement
    if (internals.yjsModel.hasParent) {
      internals.parent = deref(this.__doc__!, [internals.yjsModel.parent!]) as Parent;
      internals.parentKey = internals.yjsModel.parentKey;
      internals.parentMetadata = internals.yjsModel.parentMetadata;
    }

    for (const [key, type] of Object.entries(this.__schema__)) {
      if (this.uuid === "root" && key === "dependencies") {
        continue;
      }
      switch (type) {
        case "val":
        case "child-val":
          internals.backingStorage.set(key, deref(this.__doc__!, internals.yjsModel.get(key) as AllowedYValue));
          break;
        case "record":
        case "child-record":
        case "set":
        case "child-set":
        case "list":
        case "child-list":
        case "map":
        case "child-map":
          this[key][materializationSymbol]();
      }
    }

    const onChange = (event: Y.YXmlEvent) => {
      // Handle attribute changes (field values)
      for (const key of event.attributesChanged) {
        if (this.__schema__[key] === "val" || this.__schema__[key] === "child-val") {
          const oldValue = internals.backingStorage.get(key);
          const yjsValue = internals.yjsModel!.get(key) as AllowedYValue;
          const newValue = deref(this.__doc__!, yjsValue);
          if (newValue !== oldValue) {
            internals.backingStorage.set(key, newValue);
            trackModification(this, key);
          }
        } else if (key in this.__schema__) {
          console.warn(
            `[Plexus: ${this.__type__}(${this.uuid}).${key}]`,
            `the value that should be preserved untouched was rewritten`,
            this,
            key,
          );
        } else {
          console.warn("attempted to write the value that is not in schema", this, key);
        }
      }
      // @ts-expect-error parent data stored as child XmlElement as private field
      if (event.childListChanged) {
        const previousParent = this.parent;
        if (internals.yjsModel!.hasParent) {
          internals.parent = deref(this.__doc__!, [internals.yjsModel!.parent!]) as Parent;
          internals.parentKey = internals.yjsModel!.parentKey;
          internals.parentMetadata = internals.yjsModel!.parentMetadata;
        } else {
          internals.parent = null;
          internals.parentKey = null;
          internals.parentMetadata = null;
        }
        if (internals.parent !== previousParent) {
          trackModification(this, "parent");
        }
      }
    };
    undoManagerNotifications.set(element, onChange);
    element.observe(onChange);
    internals.unobserve = () => {
      internals.unobserve = undefined;
      undoManagerNotifications.delete(element);
      element.unobserve(onChange);
    };
  }

  #emancipate() {
    const internals = this.__internals__;
    PlexusDependencyError.invariant(!internals.isDependency, this, "emancipated");
    if (!this.parent) {
      return;
    }

    if (currentlyEmancipating.has(this)) {
      return;
    }
    currentlyEmancipating.add(this);

    const parent = this.parent;
    const parentKey = internals.yjsModel
      ? (internals.yjsModel.parentKey ?? internals.parentKey!)
      : internals.parentKey!;
    const extraParentMetadata = internals.yjsModel
      ? (internals.yjsModel.parentMetadata ?? internals.parentMetadata)
      : internals.parentMetadata;

    internals.yjsModel?.clearParentData();
    internals.parent = null;

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch ((parent.constructor as PlexusConstructor).schema[parentKey]) {
      case "child-val":
        parent[parentKey] = null;
        break;
      case "child-set":
        parent[parentKey].delete(this);
        break;
      case "child-list": {
        const childIndex = (parent[parentKey] as any[]).indexOf(this);
        if (childIndex !== -1) {
          (parent[parentKey] as any[]).splice(childIndex, 1);
        }
        break;
      }
      case "child-record":
        delete parent[parentKey][extraParentMetadata!];
        break;
      case "child-map":
        // extraParentMetadata contains the serialized key
        // We need to find and delete the entry with this child as value
        for (const [k, v] of (parent[parentKey] as Map<any, any>).entries()) {
          if (v === this) {
            (parent[parentKey] as Map<any, any>).delete(k);
            break;
          }
        }
        break;
    }
    currentlyEmancipating.delete(this);
  }
}
