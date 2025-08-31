import type { Constructor, OptionalKeysOf, Tagged, Writable } from "type-fest";
import type * as Y from "yjs";
import type { tag } from "type-fest/source/tagged";
import { LastOfUnion } from "type-fest/source/union-to-tuple";
import { curryMaybeReference } from "./utils";
import { DependencyId } from "./plexus";

export const isProxyEntity = Symbol("is Plexus proxy");
export const referenceSymbol = Symbol("reference");
export const documentDisclosureSymbol = Symbol("referenceDisclosure");
export const materializationSymbol = Symbol("materialize proxy structure");
export const informAdoptionSymbol = Symbol("report parentship change");
export const informOrphanizationSymbol = Symbol("report orphanage");
export const requestAdoptionSymbol = Symbol("report parentship change");
export const requestOrphanizationSymbol = Symbol("report orphanage");

export type ParentReference = [entityId: string, fieldName: string, metadata?: string];
// New tuple-based references (memory optimized)
type LocalReferenceeTuple = [entityId: string];
type CrossProjectReferenceTuple = [entityId: string, dependencyId: DependencyId];
export type ReferenceTuple = LocalReferenceeTuple | CrossProjectReferenceTuple;

export type AllowedPrimitive = string | number | boolean | null;
export type AllowedYValue = AllowedPrimitive | ReferenceTuple;
export type ModelPattern = Tagged<{}, "syncing", string>;
export type PlexusID = Tagged<string, "Plexus ID">;
export type AllowedYJSValue = AllowedPrimitive | ModelPattern;
export type AllowedYJSValueSet = Set<AllowedYJSValue>;
export type AllowedYJSValueMap = Record<string, AllowedYJSValue>;
export type AllowedYJSValueList = Array<AllowedYJSValue>;
export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

export type ReferenceProjector = (doc: Y.Doc) => ReferenceTuple;

type ModelInternals<T extends LegitimateSchema<T>, Class extends string> = {
  readonly uuid: Tagged<string, "Plexus ID", ModelType<T, Class>>;
  readonly constructor: ModelConstructor<T, Class>;
  readonly parent: ModelPattern | null;
  clone<TT extends ModelPattern>(this: TT, newProps?: Partial<T>): TT;
  readonly [isProxyEntity]: true;
  readonly [referenceSymbol]: ReferenceProjector;
  readonly [informOrphanizationSymbol]: () => void;
  readonly [informAdoptionSymbol]: (newParent: ModelPattern, field: string, extraMetadata?: string) => void;
  readonly [requestOrphanizationSymbol]: () => void;
  readonly [requestAdoptionSymbol]: (newParent: ModelPattern, field: string, extraMetadata?: string) => void;
  readonly [documentDisclosureSymbol]?: () => {
    doc: Y.Doc;
  };
};

// system this complex is needed to materialize readonly flag WITHOUT touching field itself that will cause cyclic dependency triggered
// it can be obviously done with ReadonlyKeys from type-fest when we're not dealing on cyclic dependencies but for our case this is crucial
type IsFieldReadonly<A extends ModelStateInit, Key extends keyof A> =
  (<G>() => G extends ({ [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2) extends <
    G
  >() => G extends ({ readonly [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2
    ? Key
    : never;

type ReadonlyFields<A extends ModelStateInit, ExcludedKeys extends keyof A = never> =
  LastOfUnion<Exclude<keyof A, ExcludedKeys>> extends infer Head extends keyof A
    ? IsFieldReadonly<A, Head> | ReadonlyFields<A, ExcludedKeys | Head>
    : never;

type IsFieldNullable<A extends ModelStateInit, Key extends keyof A> =
  (<G, G2>() => G extends { [Q in keyof A as Q extends Key ? Q : never]: G2 | null } ? 1 : 2) extends <
    G,
    G2
  >() => G extends A ? 1 : 2
    ? Key
    : never;

type NullableFields<A extends ModelStateInit, ExcludedKeys extends keyof A = never> =
  LastOfUnion<Exclude<keyof A, ExcludedKeys>> extends infer Head extends keyof A
    ? IsFieldNullable<A, Head> | NullableFields<A, ExcludedKeys | Head>
    : never;

declare class ReadonlyField<T> {
  assign(value: T): void;
  clear(): void;
  [materializationSymbol](
    struct: Y.Array<AllowedYValue> | Y.Map<AllowedYJSValue>,
    boundMaybeReference: ReturnType<typeof curryMaybeReference>
  ): void;
}

export type ModelState<T extends ModelPattern> =
  T extends ModelType<infer S, string> ? (S extends LegitimateSchema<S> ? S : never) : never;
export type ModelName<T extends ModelPattern> = T extends ModelType<{}, infer N> ? N : never;

export type LegitimateSchema<T extends ModelStateInit> =
  | Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyFields<T>>
  | OptionalKeysOf<T> extends never
  ? ModelStateInit
  : never;

export type ModelType<T extends LegitimateSchema<T>, Class extends string> = Tagged<
  T & {
    readonly [key in ReadonlyFields<T>]: ReadonlyField<T[key]>;
  } & ModelInternals<T, Class>,
  "syncing",
  Class
>;

export type ModelConstructorInit<T extends LegitimateSchema<T>, Class extends string> = Writable<
  Omit<T, keyof ModelInternals<T, Class> | typeof tag | ReadonlyFields<T> | NullableFields<T>> &
    Partial<
      Pick<
        Omit<T, keyof ModelInternals<T, Class> | typeof tag>,
        | ReadonlyFields<Omit<T, keyof ModelInternals<T, Class> | typeof tag>>
        | NullableFields<Omit<T, keyof ModelInternals<T, Class> | typeof tag>>
      >
    >
> & {
  parent?: never;
  uuid?: never;
};

export type ModelConstructor<T extends LegitimateSchema<T>, Class extends string> = Tagged<
  Constructor<ModelType<T, Class>, [ModelConstructorInit<T, Class>]> & {
    __type: Class;
    schema: ModelSchema<T> & GenericRecordSchema;
    spawn: (entityId: string, yjs: Y.Doc) => ModelType<T, Class>;
  },
  "syncingConstructor",
  string
>;
export type ModelStateInit = Record<
  string,
  AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
>;

export type MaterializedRecordSchemaReadonlyKeys<T extends ModelStateInit> = keyof {
  [key in keyof T as T[key] extends ModelPattern | AllowedPrimitive ? never : key]: key extends typeof tag
    ? never
    : key;
};

type PureSchema<T extends LegitimateSchema<T>> = Extract<
  Omit<T, keyof ModelInternals<T, string> | typeof tag>,
  ModelStateInit
>;

export type GenericRecordSchema = Record<string, `${"child-" | ""}${"val" | "record" | "set" | "list"}`>;

export type ModelSchema<T extends LegitimateSchema<T>> =
  PureSchema<T> extends infer TT
    ? {
        [key in keyof TT]: TT[key] extends AllowedYJSValue | null
          ? "val" | "child-val"
          : TT[key] extends AllowedYJSValueMap | null
            ? "record" | "child-record"
            : TT[key] extends AllowedYJSValueSet | null
              ? "set" | "child-set"
              : TT[key] extends AllowedYJSValueList | null
                ? "list" | "child-list"
                : never;
      }
    : never;
