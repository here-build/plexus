import type { Constructor, OptionalKeysOf, ReadonlyKeysOf, Tagged, Writable } from "type-fest";
import type * as Y from "yjs";
import type { tag } from "type-fest/source/tagged";

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

type ModelInternals = {
  readonly uuid: string;
  readonly [referenceSymbol]: (projectId: string, doc: Y.Doc) => ReferenceTuple;
  readonly [referenceDisclosureSymbol]?: () => {
    projectId: ProjectId;
    doc: Y.Doc;
  };
};

export type ModelType<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
  Class extends string = string
> = Tagged<T & ModelInternals, "syncing", Class>;

export type SpecificModelType<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
  Name extends string = string
> = ModelType<T, Name>;
export type ModelTypeConstructor<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
  Name extends string
> = Tagged<
  Constructor<
    SpecificModelType<T, Name>,
    [Writable<Omit<T, keyof ModelInternals | typeof tag>>]
  > & {
    __type: Name;
    schema: RecordSchema<T>;
    spawn: (entityId: string, projectId: string, yjs: Y.Doc) => SpecificModelType<T, Name>;
  },
  "syncingConstructor",
  string
>;
export type RecordSchemaInput = Record<string, AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList>;

export type MaterializedRecordSchemaReadonlyKeys<T extends RecordSchemaInput> = keyof {
  [key in keyof T as T[key] extends ModelPattern | AllowedPrimitive ? never : key]: key extends typeof tag
    ? never
    : key;
};

type PureSchema<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never
> = Extract<Omit<T, keyof ModelInternals | typeof tag>, RecordSchemaInput>;

export type RecordSchema<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never
> =
  PureSchema<T> extends infer TT
    ? {
        [key in keyof TT]: TT[key] extends AllowedYJSValue | null
          ? "val"
          : TT[key] extends AllowedYJSValueMap | null
            ? "map"
            : TT[key] extends AllowedYJSValueSet | null
              ? "set"
              : TT[key] extends AllowedYJSValueList | null
                ? "list"
                : never;
      }
    : never;
export type StrictRecordSchema<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never
> = T extends infer ReadonlyProps extends Record<keyof T, AllowedYJSValue>
  ? Readonly<Pick<T, keyof ReadonlyProps>> & Omit<T, keyof ReadonlyProps>
  : T;

type a = ModelType<{
  a: a;
  readonly b: number[];
}>;
