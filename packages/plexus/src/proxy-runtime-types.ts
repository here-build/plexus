import type { Constructor, OptionalKeysOf, Tagged, UnionToTuple, Writable } from "type-fest";
import type * as Y from "yjs";
import type { tag } from "type-fest/source/tagged";
import { LastOfUnion } from "type-fest/source/union-to-tuple";

// For standalone usage - ProjectId can be overridden by consuming applications
export type ProjectId = string;
export type ProjectVersionId = string;

export const isProxyEntity = Symbol("isProxyEntity");
export const referenceSymbol = Symbol("reference");
export const referenceDisclosureSymbol = Symbol("referenceDisclosure");

// New tuple-based references (memory optimized)
type LocalReferenceeTuple = [entityId: string];
type CrossProjectReferenceTuple = [entityId: string, projectId: string];
export type ReferenceTuple = LocalReferenceeTuple | CrossProjectReferenceTuple;

export type AllowedPrimitive = string | number | boolean | null;
export type AllowedYValue = AllowedPrimitive | ReferenceTuple;
export type ModelPattern = Tagged<object, "syncing", string>;
export type AllowedYJSValue = AllowedPrimitive | ModelPattern;
export type AllowedYJSValueSet = Set<AllowedYJSValue>;
export type AllowedYJSValueMap = Record<string, AllowedYJSValue>;
export type AllowedYJSValueList = Array<AllowedYJSValue>;
export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

type ModelInternals<T extends LegitimateSchema<T>, Class extends string = string> = {
  readonly uuid: string;
  clone(): ModelType<T, Class>;
  readonly [referenceSymbol]: (projectId: string, doc: Y.Doc) => ReferenceTuple;
  readonly [referenceDisclosureSymbol]?: () => {
    projectId: ProjectId;
    doc: Y.Doc;
  };
};

// system this complex is needed to materialize readonly flag WITHOUT touching field itself that will cause cyclic dependency triggered
// it can be obviously done with ReadonlyKeys from type-fest when we're not dealing on cyclic dependencies but for our case this is crucial
type IsFieldReadonly<A extends RecordSchemaInput, Key extends keyof A> =
  (<G>() => G extends ({ [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2) extends <
    G
  >() => G extends ({ readonly [Q in keyof A as Q extends Key ? Q : never]: true } & G) | G ? 1 : 2
    ? Key
    : never;

type ReadonlyFields<A extends RecordSchemaInput, ExcludedKeys extends keyof A = never> =
  LastOfUnion<Exclude<keyof A, ExcludedKeys>> extends infer Head extends keyof A
    ? IsFieldReadonly<A, Head> | ReadonlyFields<A, ExcludedKeys | Head>
    : never;

type EnrichedModel<T extends LegitimateSchema<T>> = {
  readonly [key in ReadonlyFields<T>]: {
    assign<P extends keyof T>(key: P, value: T[P]): void;
    clear(): void;
  };
};

type LegitimateSchema<T extends RecordSchemaInput> =
  | Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyFields<T>>
  | OptionalKeysOf<T> extends never
  ? RecordSchemaInput
  : never;

export type ModelType<T extends LegitimateSchema<T>, Class extends string = string> = Tagged<
  T & ModelInternals<T> & EnrichedModel<T>,
  "syncing",
  Class
>;

export type ModelTypeConstructor<T extends LegitimateSchema<T>, Name extends string> = Tagged<
  Constructor<ModelType<T, Name>, [Writable<Omit<T, keyof ModelInternals<{}> | typeof tag>>]> & {
    __type: Name;
    schema: RecordSchema<T>;
    spawn: (entityId: string, projectId: string, yjs: Y.Doc) => ModelType<T, Name>;
  },
  "syncingConstructor",
  string
>;
export type RecordSchemaInput = Record<
  string,
  AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
>;

export type MaterializedRecordSchemaReadonlyKeys<T extends RecordSchemaInput> = keyof {
  [key in keyof T as T[key] extends ModelPattern | AllowedPrimitive ? never : key]: key extends typeof tag
    ? never
    : key;
};

type PureSchema<T extends LegitimateSchema<T>> = Extract<
  Omit<T, keyof ModelInternals<{}> | typeof tag>,
  RecordSchemaInput
>;

export type RecordSchema<T extends LegitimateSchema<T>> =
  PureSchema<T> extends infer TT
    ? {
        [key in keyof TT]: TT[key] extends AllowedYJSValue | null
          ? "val"
          : TT[key] extends AllowedYJSValueMap | null
            ? "record"
            : TT[key] extends AllowedYJSValueSet | null
              ? "set"
              : TT[key] extends AllowedYJSValueList | null
                ? "list"
                : never;
      }
    : never;
export type StrictRecordSchema<T extends LegitimateSchema<T>> = T extends infer ReadonlyProps extends Record<
  keyof T,
  AllowedYJSValue
>
  ? Readonly<Pick<T, keyof ReadonlyProps>> & Omit<T, keyof ReadonlyProps>
  : T;
