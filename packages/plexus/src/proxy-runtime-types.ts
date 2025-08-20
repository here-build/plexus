import type { Constructor, OptionalKeysOf, ReadonlyKeysOf, Tagged } from "type-fest";
import type * as Y from "yjs";
import type { RemoveAllTags } from "type-fest/source/tagged";

// For standalone usage - ProjectId can be overridden by consuming applications
export type ProjectId = string;
export type ProjectVersionId = string;

export const isProxyEntity = Symbol("isProxyEntity");
export const referenceSymbol = Symbol("reference");
export const referenceDisclosureSymbol = Symbol("referenceDisclosure");

interface Addr {
  iid: string;
  uuid: ProjectId | ProjectVersionId;
}

type InternalReference = { __ref: string };
type ExternalReference = { __xref: Addr };
export type Reference = InternalReference | ExternalReference;
export type AllowedPrimitive = string | number | boolean | null;
export type AllowedYValue = AllowedPrimitive | Reference;
export type ModelPattern = Tagged<object, "syncing", string>;
export type AllowedYJSValue = AllowedPrimitive | ModelPattern;
export type AllowedYJSValueMap = Record<string, AllowedPrimitive | ModelPattern>;
export type AllowedYJSValueList = Array<AllowedPrimitive | ModelPattern>;
export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

type ModelInternals = {
  [referenceSymbol]: (projectId: string, doc: Y.Doc) => Reference;
  [referenceDisclosureSymbol]?: () => {
    projectId: ProjectId;
    doc: Y.Doc;
  };
};

export type ModelType<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
  Class extends string = string,
> = Tagged<T & ModelInternals, "syncing", Class>;

export type SpecificModelType<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
  Name extends string = string,
> = ModelType<T, Name>;
export type ModelTypeConstructor<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
  Name extends string,
> = Tagged<
  Constructor<SpecificModelType<T, Name>, [T]> & {
    __type: Name;
    schema: RecordSchema<T>;
    spawn: (entityId: string, projectId: string, yjs: Y.Doc) => SpecificModelType<T, Name>;
  },
  "syncingConstructor",
  string
>;
export type RecordSchemaInput = Record<string, AllowedYJSValue | AllowedYJSValueMap | AllowedYJSValueList>;

export type MaterializedRecordSchemaReadonlyKeys<T extends RecordSchemaInput> = keyof {
  [key in keyof T as T[key] extends ModelPattern | AllowedPrimitive ? never : key]: key;
};

type PureSchema<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
> = Extract<Omit<RemoveAllTags<T>, typeof referenceSymbol | typeof referenceDisclosureSymbol>, RecordSchemaInput>;

export type RecordSchema<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
> =
  PureSchema<T> extends infer TT
    ? {
        [key in keyof TT]: TT[key] extends AllowedYJSValue | null
          ? "val"
          : TT[key] extends AllowedYJSValueMap | null
            ? "map"
            : TT[key] extends AllowedYJSValueList | null
              ? "list"
              : never;
      }
    : never;
export type StrictRecordSchema<
  T extends Exclude<MaterializedRecordSchemaReadonlyKeys<T>, ReadonlyKeysOf<T>> | OptionalKeysOf<T> extends never
    ? RecordSchemaInput
    : never,
> = T extends infer ReadonlyProps extends Record<keyof T, AllowedYJSValue>
  ? Readonly<Pick<T, keyof ReadonlyProps>> & Omit<T, keyof ReadonlyProps>
  : T;

type a = ModelType<{
  a: a;
  readonly b: number[];
}>;
