/**
 * The OBJECTS of the history log — the entities a user NAMES as a subject ("the button", "the
 * primary token", "the danger state"). Everything else is intent-application-PATH that collapses UP
 * to its owning object: a RuleSet / AttributesSet / EventHandlersSet → its element; a Variant /
 * VariantGroup → a coordinate, not a subject (lens-architecture.md §1–3). Per V's enumeration:
 * **token · component · element · data query · state** — "probably more, I cannot recall exactly;
 * rest should be part of intent application path."
 *
 * Type strings = the `@syncing("…")` nodeName the lift stamps in `entity.type`, cited per area module.
 */
export const HEREBUILD_OBJECT_TYPES: ReadonlySet<string> = new Set([
  // element — a tpl-tree node the user manipulates (areas/tpl-tree.ts)
  "TplTag",
  "TplComponent", // an instance of another component — a node, NOT the top-level component below
  "TplSlot",
  // component — top-level, named (areas/component.ts COMPONENT_TYPES)
  "PlainComponent",
  "PageComponent",
  "FrameComponent",
  // state — a component/interaction state (areas/params-states-types.ts)
  "State",
  // token — the combo-keyed value tokens (areas/tokens.ts COMBO_VALUE_TOKENS; tracks TOKEN_NOUN keys)
  "StyleToken",
  "ColorToken",
  // data query — THE query the user names (areas/data.ts). Its source/provider sub-parts stay app-path.
  "ComponentDataQuery",
]);

/*
 * CANDIDATE objects, pending V (the "probably more"). These currently fall through as application-path
 * (they collapse to a nearer object, or degrade to a raw edit). Promote into the set above once V
 * confirms each is a subject the user names — cheap to add, and the structural resolver needs no change:
 *   - data SOURCE: DataSourceDefinition / DataSourceDefinitionCustomType / DataQueryFetch / ProviderSource
 *   - operation:   ValueOperation / InvokeOperation
 *   - import:      ImportSpec / NpmPackage / NpmExportSource / CodeLibrary
 *   - split:       Split / RandomSplitSlice / SegmentSplitSlice
 *   - project:     ProjectPackage / Site / Arena / ArenaFrame
 *   - comment:     Comment / CommentsPackage
 */

export const isHerebuildObject = (type: string): boolean => HEREBUILD_OBJECT_TYPES.has(type);

/**
 * An object's `entity.type` → its human KIND noun (the `ObjectRef.kind` Pass 2 reads — "element",
 * "component", "token", …). The kind is the user-facing category, NOT the model class: a `TplTag`,
 * `TplComponent`, and `TplSlot` are all one "element"; the three component classes are one "component".
 * An unmapped (non-object) type falls back to the bare type — defensive; the composer only calls this for
 * resolved objects. DRAFT — V review (the nouns).
 */
export function objectKind(type: string): string {
  switch (type) {
    case "TplTag":
    case "TplComponent":
    case "TplSlot":
      return "element";
    case "PlainComponent":
    case "PageComponent":
    case "FrameComponent":
      return "component";
    case "State":
      return "state";
    case "StyleToken":
    case "ColorToken":
      return "token";
    case "ComponentDataQuery":
      return "data query";
    default:
      return type;
  }
}
