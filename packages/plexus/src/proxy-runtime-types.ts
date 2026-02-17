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

export type Storageable = AllowedYValue | Y.Map<AllowedYValue> | Y.Array<AllowedYValue>;

export declare class ReadonlyField<T> {
  assign(value: T): void;

  clear(): void;

  [materializationSymbol](
    struct: Y.Array<AllowedYValue> | Y.Map<AllowedYJSValue>,
    boundMaybeReference: ReturnType<typeof curryMaybeReference>,
  ): void;
}

declare const tag: unique symbol;

export interface PlexusTagContainer<Token> {
  readonly [tag]?: Token;
}

export type PlexusUUID = string & PlexusTagContainer<"plexus-uuid">;

export type GenericRecordSchema = Record<string, `${"child-" | ""}${"val" | "record" | "set" | "list" | "map"}`>;

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
      uuid?: PlexusUUID;
      reference?: ReferenceTuple;
      backingStorage: Map<string, any>;
      isDematerialized?: boolean;
      unobserve?: () => void;
    }
  | {
      isDependency: true;
      isDematerialized?: false;
      documentId: string;
      uuid: PlexusUUID;
      parent: Parent;
      reference: [string, string];
      parentKey: null;
      parentMetadata: null;
    };
