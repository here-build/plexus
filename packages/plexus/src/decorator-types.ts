import type { AllowedPrimitive, AllowedYJSValue, GenericRecordSchema } from "./proxy-runtime-types.js";
import { PlexusModel } from "./PlexusModel.js";

/**
 * This type basically says: (types logic is inverted, obviously)
 * "If you're using child field - you know what the hell you are doing".
 * Its logic is following:
 * - if it's primitives only, you do not need children
 * - if it's mixed primitives and models, it's ok, let's extract models specifically to look at them
 * - now let's look who's parent of field you passed
 * - if it's default value (any), then it's allowed value. We're not forcing for children declaration hard - sometimes it's not needed
 * - but if you decided to annotate the parent, you better make sure that it's including this specific parent
 *
 * this enables optional type-level schema validation of child-parent relations
 */
type PreDiscriminateValue<
  MappingType extends keyof Mapping<any>,
  T extends Mapping<AllowedPrimitive | PlexusModel>[MappingType],
  Parent extends PlexusModel,
> = T extends Mapping<infer Value>[MappingType]
  ? Extract<Value, PlexusModel> extends PlexusModel<infer ActualParent extends PlexusModel>
    ? any extends ActualParent
      ? T
      : Parent extends Extract<ActualParent, Parent>
        ? T
        : never
    : never
  : never;
export type DiscriminateValue<
  MappingType extends keyof Mapping<any>,
  T extends Mapping<AllowedPrimitive | PlexusModel>[MappingType],
  Parent extends PlexusModel,
> =
  PreDiscriminateValue<MappingType, T, Parent> extends never
    ? Mapping<AllowedPrimitive | PlexusModel<Parent>>[MappingType]
    : T;

export interface Mapping<T> {
  identity: T;
  record: Record<string, T>;
  set: Set<T>;
  list: T[];
}

/**
 * Pre-discrimination for map values.
 * Checks if V can be a child of Parent - returns V if valid, never if not.
 *
 * Logic (same as PreDiscriminateValue but for raw value type, not Mapping):
 * - Extract PlexusModel from V (might be V itself or part of union)
 * - If no PlexusModel in V, return never (child fields require model values)
 * - If PlexusModel has `any` parent (unspecified), allow it
 * - If PlexusModel's declared parent includes this Parent, allow it
 * - Otherwise, return never
 */
type PreDiscriminateMapValue<V extends AllowedYJSValue, Parent extends PlexusModel> =
  Extract<V, PlexusModel> extends PlexusModel<infer ActualParent extends PlexusModel>
    ? any extends ActualParent
      ? V
      : Parent extends Extract<ActualParent, Parent>
        ? V
        : never
    : never;
/**
 * Full discrimination for map values with fallback.
 * If PreDiscriminateMapValue returns never (invalid parent relationship),
 * falls back to a correctly-constrained type instead of just failing.
 */
type DiscriminateMapValue<V extends AllowedYJSValue, Parent extends PlexusModel> =
  PreDiscriminateMapValue<V, Parent> extends never
    ? AllowedPrimitive | PlexusModel<Parent>
    : PreDiscriminateMapValue<V, Parent>;
type MapKey<T extends Map<any, any>> =
  T extends Map<infer K, any>
    ?
        | (Extract<K, Set<AllowedYJSValue>> extends Set<AllowedYJSValue> ? K : never)
        | (Extract<K, Array<AllowedYJSValue>> extends Array<AllowedYJSValue> ? K : never)
        | (Extract<K, AllowedYJSValue> extends AllowedYJSValue ? K : never)
    : never;
type MapValue<T extends Map<any, any>> = T extends Map<any, infer K> ? Extract<K, AllowedYJSValue> : never;
export type DiscriminateMap<Field extends Map<any, any>, Parent extends PlexusModel> = Map<
  MapKey<Field>,
  DiscriminateMapValue<MapValue<Field>, Parent>
>;
