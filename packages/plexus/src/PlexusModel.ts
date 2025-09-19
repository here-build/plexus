import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYJSValueList,
  AllowedYJSValueMap,
  AllowedYJSValueSet,
  AllowedYValue,
  backingStorageSymbol,
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
  Storageable
} from "./proxy-runtime-types";
import { documentEntityCaches } from "./entity-cache";
import { curryMaybeReference, maybeTransacting, never } from "./utils";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import invariant from "tiny-invariant";
import { trackAccess, trackModification } from "./tracking";
import { deref } from "./deref";
import { nanoid } from "nanoid";
import { DependencyId, Plexus } from "./Plexus";
import { clone } from "./clone";

export type PlexusConstructor<T extends PlexusModel = PlexusModel> =
  | ((abstract new (...args: any) => T) & {
      modelName: string;
      schema: GenericRecordSchema;
    })
  | ((new (...args: any) => T) & {
      modelName: string;
      schema: GenericRecordSchema;
    });
export type ConcretePlexusConstructor<T extends PlexusModel = PlexusModel> = (new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};
type Initializer<T extends PlexusModel> = [entityId: string, doc: Y.Doc];

let currentlyEmancipating = new WeakSet<PlexusModel>();

export type PlexusInit<T extends PlexusModel> = {
  [key in keyof T as T[key] extends AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
    ? key extends keyof PlexusModel
      ? never
      : key
    : never]?: T[key];
};

export abstract class PlexusModel {
  static modelName: string;
  static schema: GenericRecordSchema;

  [backingStorageSymbol] = new Map<string, any>();

  #ephemeralParent: PlexusModel | null = null;
  #ephemeralParentKey: string | null = null;
  #extraParentMetadata: string | null = null;

  get _schema(): GenericRecordSchema {
    return (this.constructor as PlexusConstructor).schema;
  }

  get _type() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  _deref(target: AllowedYValue) {
    invariant(this._doc, "tried to deref without doc");
    return deref(this._doc, target);
  }

  // making things non-enumerable
  accessor _initializationState: Record<
    string,
    AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
  > = {};
  get _doc(): Y.Doc | null {
    return this._yjsModel?.doc ?? null;
  }
  accessor _yjsModel: Y.Map<Storageable> | null = null;

  constructor(
    init:
      | Record<string, AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList>
      | Initializer<typeof this> = {}
  ) {
    if (Array.isArray(init)) {
      const [entityId, doc] = init;
      const cached = documentEntityCaches.get(doc).get(entityId)?.deref();
      if (cached) {
        console.trace("this is illegal invocation and should not happen");
        return cached as any as typeof this;
      }
      documentEntityCaches.get(doc).set(entityId, new WeakRef<PlexusModel>(this));
      this.#uuid = entityId;
      const modelsMap = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
      const map = modelsMap.get(this.uuid);
      invariant(
        map,
        `you are trying to instantate ${this.constructor.name}#${entityId} that is non-existent on this document`
      );
      const storedType = map.get(YJS_GLOBALS.modelMetadataType) as string;
      invariant(storedType === this.#type, `spawn type mismatch, ${storedType} !== ${this.#type}`);
      this._yjsModel = map;
      // bootstrap should go after documentEntityCaches.set to handle circular dependencies properlt
      this.#bootstrapYjsObservation();
    } else {
      this._initializationState = init;
    }
    Object.defineProperties(
      this,
      Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(this.constructor.prototype)).filter(
          ([key]) => key in this._schema
        )
      )
    );
    Object.seal(this);
  }

  toJSON() {
    return Object.fromEntries(Object.keys(this._schema).map((key) => [key, this[key]]));
  }

  [requestEmancipationSymbol]() {
    this.#emancipate();
  }

  [informAdoptionSymbol](newParent: Exclude<(typeof this)["parent"], null>, field: string, extraFieldMetadata?: string) {
    if (!this._yjsModel) {
      if (
        this.#ephemeralParent === newParent &&
        this.#ephemeralParentKey === field &&
        this.#extraParentMetadata === extraFieldMetadata
      ) {
        return;
      }
      if (newParent._doc) {
        this[referenceSymbol](newParent._doc);
        // intentional recursion
        return this[informAdoptionSymbol](newParent, field, extraFieldMetadata);
      } else {
        this.#ephemeralParent = newParent;
        this.#ephemeralParentKey = field;
        this.#extraParentMetadata = extraFieldMetadata ?? null;
        trackModification(this, "parent");
        return;
      }
    } else {
      if (newParent._doc && this._doc) {
        invariant(
          newParent._doc === this._doc,
          "entities from other document cannot be passed to child-* fields as this breaks the hierarchy tree"
        );
      }
    }
    const currentParent = (this._yjsModel as Y.Map<any> as Y.Map<ParentReference>).get(YJS_GLOBALS.modelMetadataParent);
    const reference = newParent[referenceSymbol](this._doc!);
    if (
      currentParent &&
      currentParent[0] === reference[0] &&
      currentParent[1] === field &&
      currentParent[2] === extraFieldMetadata
    ) {
      return;
    }
    maybeTransacting(this._doc, () => {
      trackModification(this, "parent");
      (this._yjsModel as Y.Map<any> as Y.Map<ParentReference>).set(
        YJS_GLOBALS.modelMetadataParent,
        extraFieldMetadata ? [reference[0], field, extraFieldMetadata] : [reference[0], field]
      );
    });
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
    const [_, parentKey, extraParentMetadata] = this._yjsModel
      ? (this._yjsModel.get(YJS_GLOBALS.modelMetadataParent) as ParentReference)
      : [null, this.#ephemeralParentKey!, this.#extraParentMetadata];
    // avoiding circular dependencies

    this._yjsModel?.delete(YJS_GLOBALS.modelMetadataParent);
    this.#ephemeralParent = null;

    switch ((parent.constructor as PlexusConstructor).schema[parentKey]) {
      case "child-val":
        parent[parentKey] = null;
        break;
      case "child-set":
        parent[parentKey].delete(this);
        break;
      case "child-list":
        const childIndex = (parent[parentKey] as any[]).indexOf(this);
        if (childIndex !== -1) {
          (parent[parentKey] as any[]).splice(childIndex, 1);
        }
        break;
      case "child-record":
        delete parent[parentKey][extraParentMetadata!];
        break;
    }
    currentlyEmancipating.delete(this);
  }

  [requestAdoptionSymbol](newParent: Exclude<(typeof this)["parent"], null>, field: string, extraFieldMetadata?: string) {
    const parent = this.parent;
    const parentReference = this._yjsModel?.get(YJS_GLOBALS.modelMetadataParent) as any[] | undefined;
    const [_, oldField, oldExtraFieldMetadata] = this._yjsModel
      ? (parentReference ?? [null, null, null]) // circular edge case
      : [null, this.#ephemeralParentKey!, this.#extraParentMetadata];
    this.#emancipate();
    if (parent === newParent && oldField === field && oldExtraFieldMetadata === extraFieldMetadata) {
      return;
    }
    this[informAdoptionSymbol](newParent, field, extraFieldMetadata);
  }
  [informOrphanizationSymbol]() {
    if (!this._yjsModel) {
      this.#ephemeralParent = null;
      this.#ephemeralParentKey = null;
      this.#extraParentMetadata = null;
      return;
    }
    const currentParent = this._yjsModel.get(YJS_GLOBALS.modelMetadataParent) as ParentReference | undefined;
    if (currentParent) {
      maybeTransacting(this._doc, () => {
        trackModification(this, "parent");
        // it is VERY important to alter fieldMap first to avoid cyclic processing
        this._yjsModel!.delete(YJS_GLOBALS.modelMetadataParent);
      });
    }
  }
  [requestOrphanizationSymbol]() {
    this.#emancipate();
    this[informOrphanizationSymbol]();
  }

  get parent(): PlexusModel | null {
    trackAccess(this, "parent");
    if (this._doc && this._yjsModel) {
      const parentReference = (this._yjsModel as Y.Map<any>).get(YJS_GLOBALS.modelMetadataParent);
      return parentReference ? (deref(this._doc, [parentReference[0]]) as PlexusModel) : null;
    }
    return this.#ephemeralParent;
  }

  clone(newProps: Partial<typeof this> = {}): this {
    return clone(this, newProps);
  }

  #uuid: string | undefined;

  get uuid(): PlexusUUID<string, this> {
    return (this.#uuid ??= nanoid()) as PlexusUUID<string, this>;
  }

  get #reference(): ReferenceTuple {
    return [this.uuid] as const;
  }

  get #type() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  [referenceSymbol](doc: Y.Doc): ReferenceTuple {
    invariant(Plexus.docPlexus.has(doc), "passed doc is not registered as legitimate Plexus root");
    // this is needed explicitly in that manner for cyclic dependencies.
    // It will never cause cross-doc issues as we only materialize root doc entities.
    // Lucky for us, Plexus is doing not structural but reference equivalence - so we can safely assume that returning pointer will do nothing wrong.
    if (this._yjsModel?.doc) {
      if (doc !== this._yjsModel.doc) {
        const documentId = this._yjsModel.doc
          .getMap(YJS_GLOBALS.metadataMap)
          ?.get(YJS_GLOBALS.metadataMapFields.documentId) as DependencyId | undefined;
        invariant(documentId, "cannot cross-reference between docs");
        return [this.uuid, documentId];
      }
      return this.#reference;
    }
    const boundMaybeReference = curryMaybeReference(doc);
    // eslint-disable-next-line sonarjs/no-nested-functions
    return maybeTransacting(doc, () => {
      const yprojectObjectInstances = doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
      let yprojectObjectInstanceFields = yprojectObjectInstances.get(this.uuid);
      if (!yprojectObjectInstanceFields) {
        yprojectObjectInstanceFields = new Y.Map<Storageable>();
        yprojectObjectInstances.set(this.uuid, yprojectObjectInstanceFields);
        yprojectObjectInstanceFields.set(YJS_GLOBALS.modelMetadataType, this.#type);
        if (this.#ephemeralParent) {
          const parentReference = this.#ephemeralParent[referenceSymbol](doc);
          (yprojectObjectInstanceFields as Y.Map<any> as Y.Map<ParentReference>).set(
            YJS_GLOBALS.modelMetadataParent,
            this.#extraParentMetadata
              ? [parentReference[0], this.#ephemeralParentKey!, this.#extraParentMetadata]
              : [parentReference[0], this.#ephemeralParentKey!]
          );
        }
        if (this.#uuid) {
          documentEntityCaches.get(doc).set(this.#uuid, new WeakRef<PlexusModel>(this));
        }
        this._yjsModel = yprojectObjectInstanceFields;
      }
      for (const [schemaKey, type] of Object.entries(this._schema)) {
        switch (type) {
          case "val":
          case "child-val":
            yprojectObjectInstanceFields.set(
              schemaKey,
              boundMaybeReference(this[backingStorageSymbol].get(schemaKey) as AllowedYJSValue)
            );
            break;
          case "list":
          case "child-list":
            yprojectObjectInstanceFields.set(
              schemaKey,
              // @ts-expect-error todo yjs Array.from not supporting boolean
              Y.Array.from(
                // @ts-expect-error todo yjs Array.from not supporting boolean
                // Convert sparse arrays to dense arrays (holes become null)
                Array.from<AllowedYJSValue, AllowedYValue>(this[schemaKey], boundMaybeReference)
              )
            );
            break;
          case "record":
          case "child-record":
            yprojectObjectInstanceFields.set(
              schemaKey,
              new Y.Map<AllowedYValue | null>(
                Object.entries(this[schemaKey] as Record<string, AllowedYJSValue>).map(([recordKey, val]) => [
                  recordKey,
                  boundMaybeReference(val)
                ])
              )
            );
            break;
          case "set":
          case "child-set":
            yprojectObjectInstanceFields.set(
              schemaKey,
              // @ts-expect-error todo yjs Array.from not supporting boolean
              Y.Array.from(
                // Convert Set to array while mapping references
                // @ts-expect-error todo yjs Array.from not supporting boolean
                Array.from(this[schemaKey], boundMaybeReference)
              )
            );
            break;
          default:
            never(type);
        }
      }
      this.#bootstrapYjsObservation();
      documentEntityCaches.get(doc).set(this.uuid, new WeakRef<PlexusModel>(this));
      return this.#reference;
    });
  }

  #bootstrapYjsObservation() {
    invariant(this._yjsModel, "cannot bootstrap observation without yjs model");
    for (const [key, type] of Object.entries(this._schema)) {
      switch (type) {
        case "val":
        case "child-val":
          this[backingStorageSymbol].set(key, deref(this._doc!, this._yjsModel.get(key) as AllowedYValue));
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
    this._yjsModel!.observe((event) => {
      if (event.transaction.local) {
        // we handled it already
        return;
      }
      for (const key of event.keysChanged) {
        if (this._schema[key] === "val" || this._schema[key] === "child-val") {
          trackModification(this, key);
          this[backingStorageSymbol].set(key, deref(this._doc!, this._yjsModel!.get(key) as AllowedYValue));
        } else if (key in this._schema) {
          console.warn("attempted to rewrite the value that should be preserved untouched", this, key);
        } else if (key === YJS_GLOBALS.modelMetadataParent) {
          trackAccess(this, "parent");
        } else {
          console.warn("attempted to write the value that is not in schema", this, key);
        }
      }
    });
  }
}
