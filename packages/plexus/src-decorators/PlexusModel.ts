import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  GenericRecordSchema,
  informAdoptionSymbol,
  ParentReference,
  referenceSymbol,
  ReferenceTuple,
  Storageable
} from "./proxy-runtime-types";
import { documentEntityCaches } from "./globals";
import { curryMaybeReference, maybeTransacting, never } from "./utils";
import { YJS_GLOBALS } from "./YJS_GLOBALS";
import invariant from "tiny-invariant";
import { trackAccess } from "./tracking";
import { deref } from "./deref";
import { nanoid } from "nanoid";
import { Plexus } from "./plexus";
import { clone } from "./clone";

export type PlexusConstructor<T extends PlexusModel = PlexusModel> = (new (...args: any) => T) & {
  modelName: string;
  schema: GenericRecordSchema;
};
type Initializer<T extends PlexusModel> = [entityId: string, doc: Y.Doc];
const informManifestation = Symbol("PlexusModel.informManifestation");
const manifestedEntity = Symbol("PlexusModel.manifestedEntity");
export const symbols = {
  informManifestation,
  manifestedEntity
} as const;

export abstract class PlexusModel {
  static modelName: string;
  static schema: GenericRecordSchema;

  _constructionComplete = false;
  [symbols.manifestedEntity]: typeof this | null = null;
  #ephemeralParent: PlexusModel | null = null;
  #ephemeralParentKey: string | null = null;
  #extraParentMetadata: string | null = null;

  get _schema(): GenericRecordSchema {
    return (this.constructor as PlexusConstructor).schema;
  }

  _doc: Y.Doc | null = null;

  _deref(target: AllowedYValue) {
    invariant(this._doc, "tried to deref without doc");
    return deref(this._doc, target);
  }

  _yjsModel: Y.Map<Storageable> | null = null;

  constructor(init: Partial<typeof this> | Initializer<typeof this> = {}) {
    if (Array.isArray(init)) {
      const [entityId, doc] = init;
      const cached = documentEntityCaches.get(doc).get(entityId)?.deref();
      if (cached) {
        return cached as any as typeof this;
      }
      this.#uuid = entityId;
      this._doc = doc;
      const modelsMap = this._doc.getMap<Y.Map<Storageable>>(YJS_GLOBALS.models);
      const map = modelsMap.get(this.uuid);
      if (map) {
        const storedType = map.get(YJS_GLOBALS.modelMetadataType) as string;
        invariant(storedType === this.#type, `spawn type mismatch, ${storedType} !== ${this.#type}`);
        this._yjsModel = map;
      }

      documentEntityCaches.get(doc).set(entityId, new WeakRef(this));
    } else {
      Object.assign(this, init);
    }
    this._constructionComplete = true;
    return Object.seal(this);
  }

  get parent() {
    trackAccess(this, "parent");
    if (this._doc && this._yjsModel) {
      return deref(this._doc, (this._yjsModel as Y.Map<any>).get(YJS_GLOBALS.modelMetadataParent)?.[0] ?? null);
    }
    return this.#ephemeralParent;
  }

  clone(newProps: Partial<typeof this> = {}): this {
    return clone(this, newProps);
  }

  #uuid: string | undefined;

  get uuid(): string {
    return (this.#uuid ??= nanoid());
  }

  get #reference(): ReferenceTuple {
    return [this.uuid] as const;
  }

  get #type() {
    return (this.constructor as PlexusConstructor).modelName;
  }

  get #schema() {
    return (this.constructor as PlexusConstructor).schema;
  }

  [referenceSymbol](doc: Y.Doc): ReferenceTuple {
    invariant(Plexus.docPlexus.has(doc), "passed doc is not registered as legitimate Plexus root");
    // this is needed explicitly in that manner for cyclic dependencies.
    // It will never cause cross-doc issues as we only materialize root doc entities.
    // Lucky for us, Plexus is doing not structural but reference equivalence - so we can safely assume that returning pointer will do nothing wrong.
    if (this._yjsModel) {
      invariant(doc === this._doc, "cannot cross-reference between docs");
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
      }
      for (const [schemaKey, type] of Object.entries(this.#schema)) {
        switch (type) {
          case "val":
          case "child-val":
            yprojectObjectInstanceFields.set(schemaKey, boundMaybeReference(this[schemaKey] as AllowedYJSValue));
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
      documentEntityCaches.get(doc).set(this.uuid, new WeakRef<PlexusModel>(this));
      return this.#reference;
    });
  }
}
