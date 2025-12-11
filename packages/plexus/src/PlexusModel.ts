import "@here.build/arrival-env";
import { nanoid } from "nanoid";
import invariant from "tiny-invariant";
import * as Y from "yjs";

import { clone } from "./clone.js";
import { deref } from "./deref.js";
import { documentEntityCaches } from "./entity-cache.js";
import type { DependencyId } from "./Plexus.js";
import { undoManagerNotifications } from "./Plexus.js";
import { docPlexus } from "./plexus-registry.js";
import {
  AllowedYJSValue,
  AllowedYJSValueList,
  AllowedYJSValueMap,
  AllowedYJSValueSet,
  AllowedYValue,
  GenericRecordSchema,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  materializationSymbol,
  ParentReference,
  PlexusUUID,
  referenceSymbol,
  ReferenceTuple,
  requestAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  Storageable,
} from "./proxy-runtime-types.js";
import { trackAccess, trackModification } from "./tracking.js";
import { curryMaybeReference, maybeTransacting, never } from "./utils/index.js";
import * as YJS_GLOBALS from "./YJS_GLOBALS.js";
import { Constructor } from "type-fest";

export type PlexusConstructor<T extends PlexusModel = PlexusModel> = (
  | ((abstract new (...args: any) => T) & {})
  | ((new (...args: any) => T) & {})
) & {
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

export abstract class PlexusModel<Parent extends PlexusModel = any> {
  static __isMaterializingRaw__ = false;

  constructor(init: unknown = {}) {
    // we're hiding internals from enumeration and serialization aggressively
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
    Object.defineProperty(this, "__internals__", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: this.__internals__,
    });
    // after we're bootstrapped, initializationState is not needed anymore
    setTimeout(() => {
      // @ts-expect-error
      this.__internals__.initializationState = null;
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
            "terribly wrong state: this in PlexusModel constructor do not have lineage up to PlexusModel",
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
              configurable: false,
            } satisfies PropertyDescriptor,
          ] as const;
        }),
      ),
    );
  }

  static modelName: string;
  static readonly schema: GenericRecordSchema;

  // here and in other places we're using accessors only to remove elements from enumerable set
  __internals__: {
    parent: Parent | null;
    parentKey: string | null;
    parentMetadata: string | null;
    initializationState: Record<
      string,
      AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
    >;
    isWithinYjsModelSeed: boolean;
    yjsModel?: Y.Map<Y.Map<Storageable> | string | ParentReference>;
    yjsFieldsMap?: Y.Map<Storageable>;
    uuid?: string;
    localReference?: ReferenceTuple;
    backingStorage: Map<string, any>;
  };

  static __materializeRaw__<T extends PlexusModel>(constructor: Constructor<T>) {
    PlexusModel.__isMaterializingRaw__ = true;
    try {
      return new constructor();
    } finally {
      PlexusModel.__isMaterializingRaw__ = false;
    }
  }

  get __schema__(): GenericRecordSchema {
    return (this.constructor as PlexusConstructor).schema;
  }

  get __type__() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  get __doc__(): Y.Doc | null {
    return this.__internals__.yjsModel?.doc ?? null;
  }

  get __yjsFieldsMap__() {
    return this.__internals__.yjsModel?.get(YJS_GLOBALS.models.recordFields.fields) as Y.Map<Storageable> | undefined;
  }

  get parent(): Parent | null {
    trackAccess(this, "parent");
    return this.__internals__.parent;
  }

  get uuid(): PlexusUUID<string, this> {
    if (this.__internals__.uuid) {
      return this.__internals__.uuid as PlexusUUID<string, this>;
    }
    this.__internals__.uuid = nanoid() as PlexusUUID<string, this>;
    this.__internals__.localReference = [this.__internals__.uuid];
    Object.freeze(this.__internals__.localReference);
    return this.__internals__.uuid as PlexusUUID<string, this>;
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

  [informAdoptionSymbol]<T extends Parent>(newParent: T, field: string, extraFieldMetadata?: string) {
    invariant(
      this.__internals__.uuid !== YJS_GLOBALS.models.wellKnown.root || (newParent as PlexusModel) === this,
      "Root entity cannot have a parent",
    );

    if (
      this.__internals__.parent === newParent &&
      this.__internals__.parentKey === field &&
      this.__internals__.parentMetadata === extraFieldMetadata
    ) {
      return;
    }
    if (!this.__internals__.yjsModel && newParent.__doc__) {
      this[referenceSymbol](newParent.__doc__);
    } else {
      if (newParent.__doc__ && this.__doc__) {
        invariant(
          newParent.__doc__ === this.__doc__,
          "entities from other document cannot be passed to child-* fields as this breaks the hierarchy tree",
        );
      }
    }

    const oldParent = this.__internals__.parent;
    this.__internals__.parent = newParent;
    this.__internals__.parentKey = field;
    this.__internals__.parentMetadata = extraFieldMetadata ?? null;

    maybeTransacting(this.__doc__, () => {
      if (this.__doc__) {
        const reference = newParent[referenceSymbol](this.__doc__!);

        this.__internals__.yjsModel!.set(
          YJS_GLOBALS.models.recordFields.parent,
          extraFieldMetadata ? [reference[0], field, extraFieldMetadata] : [reference[0], field],
        );
      }
      if (oldParent !== newParent) {
        trackModification(this, "parent");
      }
    });
  }

  [requestAdoptionSymbol](
    newParent: Exclude<(typeof this)["parent"], null>,
    field: string,
    extraFieldMetadata?: string,
  ) {
    const parent = this.parent;
    const oldField = this.__internals__.parentKey;
    const oldExtraFieldMetadata = this.__internals__.parentMetadata;
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
    this.__internals__.parent = null;
    this.__internals__.parentKey = null;
    this.__internals__.parentMetadata = null;
    if (this.__internals__.yjsModel) {
      const currentParent = this.__internals__.yjsModel.get(YJS_GLOBALS.models.recordFields.parent) as
        | ParentReference
        | undefined;
      if (currentParent) {
        maybeTransacting(this.__doc__, () => {
          // it is VERY important to alter fieldMap first to avoid cyclic processing
          this.__internals__.yjsModel!.delete(YJS_GLOBALS.models.recordFields.parent);
          trackModification(this, "parent");
        });
      }
    }
  }

  clone<T extends PlexusModel>(this: T, newProps: Partial<Omit<T, keyof PlexusModel>> = {}): T {
    return clone(this, newProps);
  }

  [referenceSymbol](doc: Y.Doc): ReferenceTuple {
    invariant(docPlexus.has(doc), "passed doc is not registered as legitimate Plexus root");
    // this is needed explicitly in that manner for cyclic dependencies.
    // It will never cause cross-doc issues as we only materialize root doc entities.
    // Lucky for us, Plexus is doing not structural but reference equivalence - so we can safely assume that returning pointer will do nothing wrong.
    if (this.__internals__.yjsModel?.doc) {
      if (doc !== this.__internals__.yjsModel.doc) {
        const documentId = this.__internals__.yjsModel.doc
          .getMap(YJS_GLOBALS.metadata.key)
          ?.get(YJS_GLOBALS.metadata.wellKnown.documentId) as DependencyId | undefined;
        invariant(documentId, "cannot cross-reference between docs");
        return [this.uuid, documentId];
      }
      return this.#reference;
    }
    const boundMaybeReference = curryMaybeReference(doc);

    return maybeTransacting(doc, () => {
      const yprojectObjectInstances = doc.getMap<Y.Map<Y.Map<Storageable> | string | ParentReference>>(
        YJS_GLOBALS.models.key,
      );
      // technically, it should not happen at all (as _yjsModel presence is basically equivalent to representation
      // in YJS_GLOBALS.models.key - but there may be weird edge cases like class rehydration, so better to handle
      // explicitly
      let yprojectObjectInstance = yprojectObjectInstances.get(this.uuid);
      // sadly, yjs do not support "struct" types - only flat maps; yet, we know that
      let yprojectObjectInstanceFields = yprojectObjectInstance?.get(
        YJS_GLOBALS.models.recordFields.fields,
      ) as Y.Map<Storageable>;
      this.__internals__.isWithinYjsModelSeed = true;
      if (!yprojectObjectInstance) {
        yprojectObjectInstanceFields = new Y.Map();
        yprojectObjectInstance = new Y.Map([
          [YJS_GLOBALS.models.recordFields.fields, yprojectObjectInstanceFields],
          [YJS_GLOBALS.models.recordFields.type, this.#type],
        ]);
        yprojectObjectInstances.set(this.uuid, yprojectObjectInstance);
        if (this.__internals__.parent) {
          const parentReference = this.__internals__.parent[referenceSymbol](doc);
          (yprojectObjectInstance as Y.Map<ParentReference>).set(
            YJS_GLOBALS.models.recordFields.parent,
            this.__internals__.parentMetadata
              ? [parentReference[0], this.__internals__.parentKey!, this.__internals__.parentMetadata]
              : [parentReference[0], this.__internals__.parentKey!],
          );
        }
        if (this.__internals__.uuid) {
          documentEntityCaches.get(doc).set(this.__internals__.uuid, new WeakRef<PlexusModel>(this));
        }
        // it should be placed before schema iteration to avoid circular self-reference issues
        this.__internals__.yjsModel = yprojectObjectInstance;
      }
      for (const [schemaKey, type] of Object.entries(this.__schema__)) {
        switch (type) {
          case "val":
          case "child-val":
            yprojectObjectInstanceFields.set(
              schemaKey,
              boundMaybeReference(this.__internals__.backingStorage.get(schemaKey) as AllowedYJSValue),
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
          default:
            never(type);
        }
      }
      this.__bootstrapObservation__();
      documentEntityCaches.get(doc).set(this.uuid, new WeakRef<PlexusModel>(this));
      this.__internals__.isWithinYjsModelSeed = false;
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
    invariant(this.__internals__.yjsModel, "cannot bootstrap observation without yjs model");

    // Initialize runtime parent from Y.js
    const parentReference = this.__internals__.yjsModel.get(YJS_GLOBALS.models.recordFields.parent) as
      | ParentReference
      | undefined;
    if (parentReference) {
      this.__internals__.parent = deref(this.__doc__!, [parentReference[0]]) as Parent;
      this.__internals__.parentKey = parentReference[1];
      this.__internals__.parentMetadata = parentReference[2] ?? null;
    }

    for (const [key, type] of Object.entries(this.__schema__)) {
      switch (type) {
        case "val":
        case "child-val":
          this.__internals__.backingStorage.set(
            key,
            deref(this.__doc__!, this.__yjsFieldsMap__!.get(key) as AllowedYValue),
          );
          break;
        case "record":
        case "child-record":
        case "set":
        case "child-set":
        case "list":
        case "child-list":
          this[key][materializationSymbol]();
      }
    }

    const onChange = (event: Y.YMapEvent<any>) => {
      for (const key of event.keysChanged) {
        if (this.__schema__[key] === "val" || this.__schema__[key] === "child-val") {
          const oldValue = this.__internals__.backingStorage.get(key);
          const yjsValue = this.__yjsFieldsMap__!.get(key) as AllowedYValue;
          const newValue = deref(this.__doc__!, yjsValue);
          if (key === "primaryChild") {
            console.log("[onChange] primaryChild change detected");
            console.log("  Y.js value:", yjsValue);
            console.log("  oldValue:", oldValue);
            console.log("  newValue:", newValue);
            console.log("  equal?:", oldValue === newValue);
          }
          if (newValue !== oldValue) {
            if (key === "primaryChild") {
              console.log("  -> calling trackModification");
            }
            this.__internals__.backingStorage.set(key, newValue);
            trackModification(this, key);
          } else if (key === "primaryChild") {
            console.log("  -> NOT calling trackModification (values equal)");
          }
        } else if (key in this.__schema__) {
          console.warn("attempted to rewrite the value that should be preserved untouched", this, key);
        } else if (key === YJS_GLOBALS.models.recordFields.parent) {
          // Update runtime parent when Y.js changes
          const parentReference = this.__internals__.yjsModel!.get(YJS_GLOBALS.models.recordFields.parent) as
            | ParentReference
            | undefined;
          const previousParent = this.parent;
          if (parentReference) {
            this.__internals__.parent = deref(this.__doc__!, [parentReference[0]]) as Parent;
            this.__internals__.parentKey = parentReference[1];
            this.__internals__.parentMetadata = parentReference[2] ?? null;
          } else {
            this.__internals__.parent = null;
            this.__internals__.parentKey = null;
            this.__internals__.parentMetadata = null;
          }
          // this may be needed e.g. when item moved from one field to another in same parent
          if (this.__internals__.parent !== previousParent) {
            trackModification(this, "parent");
          }
        } else {
          console.warn("attempted to write the value that is not in schema", this, key);
        }
      }
    };
    undoManagerNotifications.set(this.__yjsFieldsMap__!, onChange);
    this.__yjsFieldsMap__!.observe(onChange);
  }

  #emancipate() {
    if (!this.parent) {
      return;
    }

    if (currentlyEmancipating.has(this)) {
      return;
    }
    currentlyEmancipating.add(this);

    const parent = this.parent;
    const [_, parentKey, extraParentMetadata] = this.__internals__.yjsModel
      ? (this.__internals__.yjsModel.get(YJS_GLOBALS.models.recordFields.parent) as ParentReference)
      : [null, this.__internals__.parentKey!, this.__internals__.parentMetadata];
    // avoiding circular dependencies

    this.__internals__.yjsModel?.delete(YJS_GLOBALS.models.recordFields.parent);
    this.__internals__.parent = null;

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
