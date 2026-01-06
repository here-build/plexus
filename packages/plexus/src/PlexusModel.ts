import "@here.build/arrival-env";
import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import type { Constructor, ReadonlyDeep } from "type-fest";
import * as Y from "yjs";

import { clone } from "./clone.js";
import { deref } from "./deref.js";
import { documentEntityCaches } from "./entity-cache.js";
import { docPlexus } from "./plexus-registry.js";
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
  materializationSymbol,
  type ParentReference,
  type PlexusTagContainer,
  type PlexusUUID,
  referenceSymbol,
  type ReferenceTuple,
  requestAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  type Storageable,
} from "./proxy-runtime-types.js";
import { serializeKey } from "./proxies/materialized-map.js";
import { trackAccess, trackModification } from "./tracking.js";
import { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
import { curryMaybeReference, maybeTransacting, never } from "./utils/utils.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";

export type PlexusConstructor<T extends PlexusModel = PlexusModel> = (abstract new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};
export type ConcretePlexusConstructor<T extends PlexusModel = PlexusModel> = (new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};

const currentlyEmancipating = new WeakSet<PlexusModel>();

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
  static __forcedInternals__: PlexusModel["__internals__"] | null = null;
  // eslint-disable-next-line sonarjs/public-static-readonly
  static modelName: string;
  // here and in other places we're using accessors only to remove elements from enumerable set
  __internals__:
    | {
        isDependency?: false;
        parent: Parent | null;
        parentKey: string | null;
        parentMetadata: string | null;
        initializationState: Record<
          string,
          AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList | undefined
        >;
        isWithinYjsModelSeed: boolean;
        yjsModel?: Y.Map<Y.Map<Storageable> | string | ParentReference>;
        yjsFieldsMap?: Y.Map<Storageable>;
        uuid?: string;
        reference?: ReferenceTuple;
        backingStorage: Map<string, any>;
        isDematerialized?: boolean;
        unobserve?: () => void;
      }
    | {
        isDematerialized?: false;
        isDependency: true;
        documentId: string;
        uuid: string;
        parent: Parent;
        reference: [string, string];
      };
  static readonly schema: GenericRecordSchema;

  constructor(init: unknown = {}) {
    // Use forced internals if provided (for dependency models), otherwise default
    if (PlexusModel.__forcedInternals__) {
      this.__internals__ = PlexusModel.__forcedInternals__;
    } else {
      this.__internals__ = {
        parent: null,
        parentKey: null,
        parentMetadata: null,
        initializationState: init as any,
        isWithinYjsModelSeed: false,
        yjsModel: undefined,
        yjsFieldsMap: undefined,
        backingStorage: new Map<string, any>(),
      };
      setTimeout(() => {
        // @ts-expect-error after we're bootstrapped, initializationState is not needed anymore
        this.__internals__.initializationState = null;
      });
    }
    // we're hiding internals from enumeration and serialization aggressively
    Object.defineProperty(this, "__internals__", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: this.__internals__,
    });
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

  get __yjsFieldsMap__() {
    invariant(
      !this.__internals__.isDependency,
      `Plexus<${this.__type__}#${this.uuid}>: dependency do not have __yjsFieldsMap__`,
    );
    return this.__internals__.yjsFieldsMap;
  }

  get uuid(): PlexusUUID<string, this> {
    if (this.__internals__.uuid) {
      return this.__internals__.uuid as PlexusUUID<string, this>;
    }
    if (this.__internals__.isDependency) {
      return this.__internals__.uuid;
    }
    this.__internals__.uuid = nanoid() as PlexusUUID<string, this>;
    this.__internals__.reference = [this.__internals__.uuid];
    Object.freeze(this.__internals__.reference);
    return this.__internals__.uuid as PlexusUUID<string, this>;
  }

  get parent(): Parent | null {
    trackAccess(this, "parent");
    return this.__internals__.parent;
  }

  get documentId(): string | undefined {
    return this.__doc__?.getMap(YJS_GLOBALS.metadata.key).get(YJS_GLOBALS.metadata.wellKnown.documentId) as
      | string
      | undefined;
  }

  static __materializePredefined__<T extends PlexusModel>(
    constructor: Constructor<T>,
    internals: PlexusModel["__internals__"],
  ) {
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

  [informAdoptionSymbol]<T extends Exclude<Parent, null>>(newParent: T, field: string, extraFieldMetadata?: string) {
    const internals = this.__internals__;
    invariant(!internals.isDependency, `Plexus<${this.__type__}#${this.uuid}>: dependency cannot be adopted`);
    invariant(
      internals.uuid !== YJS_GLOBALS.models.wellKnown.root || (newParent as PlexusModel) === this,
      `Plexus<${this.__type__}#root>: root entity cannot have a parent`,
    );

    if (
      internals.parent === newParent &&
      internals.parentKey === field &&
      internals.parentMetadata === extraFieldMetadata
    ) {
      return;
    }
    if (!internals.yjsModel && newParent.__doc__) {
      this[referenceSymbol](newParent.__doc__);
    } else {
      if (newParent.__doc__ && this.__doc__) {
        invariant(
          newParent.__doc__ === this.__doc__,
          `Plexus<${this.__type__}#${this.uuid}>: cannot adopt entity from different doc`,
        );
      }
    }

    const oldParent = internals.parent;
    internals.parent = newParent;
    internals.parentKey = field;
    internals.parentMetadata = extraFieldMetadata ?? null;

    maybeTransacting(this.__doc__, () => {
      if (this.__doc__) {
        const reference = newParent[referenceSymbol](this.__doc__!);

        internals.yjsModel!.set(
          YJS_GLOBALS.models.recordFields.parent,
          extraFieldMetadata ? [reference[0], field, extraFieldMetadata] : [reference[0], field],
        );
      }
      if (oldParent !== newParent) {
        trackModification(this, "parent");
      }
    });
  }

  [requestAdoptionSymbol]<T extends Exclude<Parent, null>>(newParent: T, field: string, extraFieldMetadata?: string) {
    const internals = this.__internals__;
    invariant(!internals.isDependency, `Plexus<${this.__type__}#${this.uuid}>: dependency cannot be adopted`);
    const parent = this.parent;
    const oldField = internals.parentKey;
    const oldExtraFieldMetadata = internals.parentMetadata;
    this.#emancipate();
    if (parent === newParent && oldField === field && oldExtraFieldMetadata === extraFieldMetadata) {
      return;
    }
    this[informAdoptionSymbol](newParent, field, extraFieldMetadata);
  }

  [requestOrphanizationSymbol]() {
    this.#emancipate();
    this[informOrphanizationSymbol]();
  }

  [informOrphanizationSymbol]() {
    const internals = this.__internals__;
    invariant(!internals.isDependency, `Plexus<${this.__type__}#${this.uuid}>: dependency cannot be orphaned`);
    internals.parent = null;
    internals.parentKey = null;
    internals.parentMetadata = null;
    if (internals.yjsModel) {
      const currentParent = internals.yjsModel.get(YJS_GLOBALS.models.recordFields.parent) as
        | ParentReference
        | undefined;
      if (currentParent) {
        maybeTransacting(this.__doc__, () => {
          // it is VERY important to alter fieldMap first to avoid cyclic processing
          internals.yjsModel!.delete(YJS_GLOBALS.models.recordFields.parent);
          trackModification(this, "parent");
        });
      }
    }
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
    const yModels = doc.getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(YJS_GLOBALS.models.key);

    if (internals.yjsModel?.doc) {
      invariant(
        doc === internals.yjsModel.doc,
        `Plexus<${this.__type__}#${this.uuid}>: cannot cross-reference between docs`,
      );
      if (yModels.has(this.uuid)) {
        // you never know what kinds of interesting states you can get in with CRDT
        invariant(
          yModels.get(this.uuid) === internals.yjsModel,
          `Plexus<${this.__type__}#${this.uuid}>: uuid conflict, already taken by different model`,
        );
      } else {
        // this MAY and is allowed to happen during the undo operations that are removing some class from model;
        // this is weird situation where Y.Map technically belongs to doc, but exists in pre-GC limbo.
        yModels.set(this.uuid, internals.yjsModel);
        internals.isDematerialized = false;
      }
      return this.#reference;
    }
    const boundMaybeReference = curryMaybeReference(doc);

    return maybeTransacting(doc, () => {
      // technically, it should not happen at all (as _yjsModel presence is basically equivalent to representation
      // in YJS_GLOBALS.models.key - but there may be weird edge cases like class rehydration, so better to handle
      // explicitly
      let yprojectObjectInstance = yModels.get(this.uuid);
      // sadly, yjs do not support "struct" types - only flat maps; yet, we know that
      let yprojectObjectInstanceFields = yprojectObjectInstance?.get(
        YJS_GLOBALS.models.recordFields.fields,
      ) as Y.Map<Storageable>;
      internals.isWithinYjsModelSeed = true;
      if (!yprojectObjectInstance) {
        yprojectObjectInstanceFields = new Y.Map();
        // we're tracking only fields map
        yprojectObjectInstance = new Y.Map([
          [YJS_GLOBALS.models.recordFields.fields, yprojectObjectInstanceFields],
          [YJS_GLOBALS.models.recordFields.type, this.#type],
        ]);
        yModels.set(this.uuid, yprojectObjectInstance!);
        // it should be placed before schema iteration to avoid circular self-reference issues
        internals.yjsModel = yprojectObjectInstance;
        internals.yjsFieldsMap = yprojectObjectInstanceFields;
        internals.isDematerialized = false; // Clear if re-materializing after undo
        documentEntityCaches.get(doc).set(this.uuid, new WeakRef(this));
        // there may be instantation loops where we need to have internals.yjsModel materialized in that flow
        if (internals.parent) {
          const parentReference = internals.parent[referenceSymbol](doc);
          (yprojectObjectInstance as Y.Map<ParentReference>).set(
            YJS_GLOBALS.models.recordFields.parent,
            internals.parentMetadata
              ? [parentReference[0], internals.parentKey!, internals.parentMetadata]
              : [parentReference[0], internals.parentKey!],
          );
        }
      } else if (internals.isDematerialized) {
        // Re-materialization of a dematerialized model (Y.Map exists but yjsModel was cleared)
        internals.yjsModel = yprojectObjectInstance;
        internals.yjsFieldsMap = yprojectObjectInstanceFields;
        internals.isDematerialized = false;
      }
      for (const [schemaKey, type] of Object.entries(this.__schema__)) {
        switch (type) {
          case "val":
          case "child-val":
            yprojectObjectInstanceFields.set(
              schemaKey,
              boundMaybeReference(internals.backingStorage.get(schemaKey) as AllowedYJSValue),
            );
            break;
          case "list":
          case "child-list":
            yprojectObjectInstanceFields.set(
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
            yprojectObjectInstanceFields.set(
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
            yprojectObjectInstanceFields.set(
              schemaKey,
              // Convert Set to array while mapping references
              // @ts-expect-error todo (maybe report to yjs?) - type issue: yjs Array.from not supporting boolean
              Y.Array.from(
                // @ts-expect-error same issue
                Array.from(this[schemaKey], boundMaybeReference),
              ),
            );
            break;
          case "map": {
            // Map proxy uses PathMap for in-memory storage, serialize for Y.Map
            const mapProxy = this[schemaKey] as Map<AllowedYJSMapKey, AllowedYJSValue>;
            const entries: [string, AllowedYValue | null][] = [];
            for (const [key, val] of mapProxy.entries()) {
              // Use serializeKey to match materialized-map.ts format (Set:, Array:, Value: prefixes)
              const serializedKey = serializeKey(key, doc);
              entries.push([serializedKey, boundMaybeReference(val)]);
            }
            yprojectObjectInstanceFields.set(schemaKey, new Y.Map<AllowedYValue | null>(entries));
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
      `Plexus<${this.__type__}#${this.uuid}>: cannot bootstrap observation without yjs model`,
    );
    if (undoManagerNotifications.has(this.__yjsFieldsMap__!)) {
      console.trace("(not-an-error) double-bootstrapping, may be reasonable to check whether optimization can be done");
      return;
    }
    // Initialize runtime parent from Y.js
    const parentReference = internals.yjsModel.get(YJS_GLOBALS.models.recordFields.parent) as
      | ParentReference
      | undefined;
    if (parentReference) {
      internals.parent = deref(this.__doc__!, [parentReference[0]]) as Parent;
      internals.parentKey = parentReference[1];
      internals.parentMetadata = parentReference[2] ?? null;
    }

    for (const [key, type] of Object.entries(this.__schema__)) {
      if (this.uuid === "root" && key === "dependencies") {
        continue;
      }
      switch (type) {
        case "val":
        case "child-val":
          internals.backingStorage.set(key, deref(this.__doc__!, this.__yjsFieldsMap__!.get(key) as AllowedYValue));
          break;
        case "record":
        case "child-record":
        case "set":
        case "child-set":
        case "list":
        case "child-list":
        case "map":
          this[key][materializationSymbol]();
      }
    }

    const onChange = (event: Y.YMapEvent<any>) => {
      for (const key of event.keysChanged) {
        if (this.__schema__[key] === "val" || this.__schema__[key] === "child-val") {
          const oldValue = internals.backingStorage.get(key);
          const yjsValue = this.__yjsFieldsMap__!.get(key) as AllowedYValue;
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
        } else if (key === YJS_GLOBALS.models.recordFields.parent) {
          // Update runtime parent when Y.js changes
          // todo this may cause problems on batch undo (when both parent and child are removed from tree) - needs revision
          const parentReference = internals.yjsModel!.get(YJS_GLOBALS.models.recordFields.parent) as
            | ParentReference
            | undefined;
          const previousParent = this.parent;
          if (parentReference) {
            internals.parent = deref(this.__doc__!, [parentReference[0]]) as Parent;
            internals.parentKey = parentReference[1];
            internals.parentMetadata = parentReference[2] ?? null;
          } else {
            internals.parent = null;
            internals.parentKey = null;
            internals.parentMetadata = null;
          }
          // this may be needed e.g. when item moved from one field to another in same parent
          if (internals.parent !== previousParent) {
            trackModification(this, "parent");
          }
        } else {
          console.warn("attempted to write the value that is not in schema", this, key);
        }
      }
    };
    const fieldsMap = this.__yjsFieldsMap__!;
    undoManagerNotifications.set(fieldsMap, onChange);
    fieldsMap.observe(onChange);
    internals.unobserve = () => {
      internals.unobserve = undefined;
      undoManagerNotifications.delete(fieldsMap);
      fieldsMap.unobserve(onChange);
    };
  }

  #emancipate() {
    const internals = this.__internals__;
    invariant(!internals.isDependency, `Plexus<${this.__type__}#${this.uuid}>: dependency cannot be emancipated`);
    if (!this.parent) {
      return;
    }

    if (currentlyEmancipating.has(this)) {
      return;
    }
    currentlyEmancipating.add(this);

    const parent = this.parent;
    const [_, parentKey, extraParentMetadata] = internals.yjsModel
      ? (internals.yjsModel.get(YJS_GLOBALS.models.recordFields.parent) as ParentReference)
      : [null, internals.parentKey!, internals.parentMetadata];
    // avoiding circular dependencies

    internals.yjsModel?.delete(YJS_GLOBALS.models.recordFields.parent);
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
    }
    currentlyEmancipating.delete(this);
  }
}
