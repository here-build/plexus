import type * as Y from "yjs";

import type { PlexusModel } from "./PlexusModel.js";
import type { curryMaybeReference } from "./utils/utils.js";

export const referenceSymbol = Symbol("reference");
export const materializationSymbol = Symbol("materialize proxy structure");
export const requestEmancipationSymbol = Symbol("request emancipation");
export const informAdoptionSymbol = Symbol("report parentship change");
export const informOrphanizationSymbol = Symbol("report orphanage");
export const requestAdoptionSymbol = Symbol("report parentship change");
export const requestOrphanizationSymbol = Symbol("report orphanage");
export const validateAdoptionSymbol = Symbol("validate adoption");

export type ParentReference = [entityId: string, fieldName: string, metadata?: string];
// New tuple-based references (memory optimized)
type LocalReferenceeTuple = [entityId: string];
export type CrossProjectReferenceTuple = [entityId: string, dependencyId: string];
export type ReferenceTuple = LocalReferenceeTuple | CrossProjectReferenceTuple;

export type AllowedPrimitive = string | number | boolean | bigint | null;
export type AllowedYValue = AllowedPrimitive | ReferenceTuple;
export type AllowedYJSValue = AllowedPrimitive | PlexusModel;
export type AllowedYJSValueSet = Set<AllowedYJSValue>;
export type AllowedYJSValueMap = Record<string, AllowedYJSValue>;
export type AllowedYJSValueList = AllowedYJSValue[];
export type AllowedYJSMapKey = AllowedYJSValue | Set<AllowedYJSValue> | AllowedYJSValue[];

/**
 * Extended Map interface for Plexus maps with bulk operations.
 * The `assign()` method replaces entire map contents atomically.
 */
export interface PlexusMap<K extends AllowedYJSMapKey, V extends AllowedYJSValue> extends Map<K, V> {
  /**
   * Replace entire map contents with new entries.
   * Clears existing entries and adds all entries from the input.
   */
  assign(entries: Iterable<[K, V]> | Record<string, V>): void;
}

export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

// system this complex is needed to materialize readonly flag WITHOUT touching field itself that will cause cyclic dependency triggered
// it can be obviously done with ReadonlyKeys from type-fest when we're not dealing on cyclic dependencies but for our case this is crucial
type IsFieldReadonly<A extends ModelStateInit, Key extends keyof A> =
  (<G>() => G extends ({ [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2) extends <
    G,
  >() => G extends ({ readonly [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2
    ? Key
    : never;

export declare class ReadonlyField<T> {
  assign(value: T): void;

  clear(): void;

  [materializationSymbol](
    struct: Y.Array<AllowedYValue> | Y.Map<AllowedYJSValue>,
    boundMaybeReference: ReturnType<typeof curryMaybeReference>,
  ): void;
}

declare const tag: unique symbol;
declare const fieldTag: unique symbol;

export type FieldTag<Value> = {
  readonly [fieldTag]?: Value;
};

export interface PlexusTagContainer<Token> {
  readonly [tag]?: Token;
}

export type PlexusTagValue<T extends PlexusTagContainer<any>> = T extends PlexusTagContainer<infer R> ? R : never;

export type PlexusUUID<Type, Model extends PlexusModel> = Type & PlexusTagContainer<{ model: Model }>;

export type ModelStateInit = Record<
  string,
  AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
>;

export type GenericRecordSchema = Record<string, `${"child-" | ""}${"val" | "record" | "set" | "list"}` | "map">;

export type Internals<Parent extends PlexusModel | null> =
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
      isDependency: true;
      isDematerialized?: false;
      documentId: string;
      uuid: string;
      parent: Parent;
      reference: [string, string];
      parentKey: null;
      parentMetadata: null;
    };
