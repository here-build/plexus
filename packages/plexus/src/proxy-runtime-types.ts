import type { UnionToIntersection } from "type-fest";
import type * as Y from "yjs";

import type { DependencyId } from "./Plexus";
import type { PlexusModel } from "./PlexusModel";
import type { curryMaybeReference } from "./utils";

export const isPlexusEntity = Symbol("is Plexus proxy");
export const referenceSymbol = Symbol("reference");
export const materializationSymbol = Symbol("materialize proxy structure");
export const requestEmancipationSymbol = Symbol("request emancipation");
export const informAdoptionSymbol = Symbol("report parentship change");
export const informOrphanizationSymbol = Symbol("report orphanage");
export const requestAdoptionSymbol = Symbol("report parentship change");
export const requestOrphanizationSymbol = Symbol("report orphanage");
export const backingStorageSymbol = Symbol("backing storage");
export const bootstrapObservationSymbol = Symbol("bootstrap observation");
export const synthetic = Symbol("synthetic constructor");

export type ParentReference = [entityId: string, fieldName: string, metadata?: string];
// New tuple-based references (memory optimized)
type LocalReferenceeTuple = [entityId: string];
export type CrossProjectReferenceTuple = [entityId: string, dependencyId: DependencyId];
export type ReferenceTuple = LocalReferenceeTuple | CrossProjectReferenceTuple;

export type AllowedPrimitive = string | number | boolean | null;
export type AllowedYValue = AllowedPrimitive | ReferenceTuple;
export type AllowedYJSValue = AllowedPrimitive | PlexusModel;
export type AllowedYJSValueSet = Set<AllowedYJSValue>;
export type AllowedYJSValueMap = Record<string, AllowedYJSValue>;
export type AllowedYJSValueList = AllowedYJSValue[];
export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

type LastOfUnion<T> = UnionToIntersection<T extends any ? () => T : never> extends () => infer R ? R : never;

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

export type PlexusTagContainer<Token> = {
  readonly [tag]: Token;
};

export type PlexusUUID<Type, Model extends PlexusModel> = Type & PlexusTagContainer<{ model: Model }>;

export type ModelStateInit = Record<
  string,
  AllowedYJSValue | AllowedYJSValueSet | AllowedYJSValueMap | AllowedYJSValueList
>;

export type GenericRecordSchema = Record<string, `${"child-" | ""}${"val" | "record" | "set" | "list"}`>;
