/**
 * `@here.build/plexus-history` — the public READ surface of the change-history layer.
 *
 * Semantic, plain-JSON changes over a gc:false archive: the lift (`changesBetween` →
 * `PlexusChange[]`), point-in-time read (`valueAsOf`), restore planning, the operators
 * (subtree-scope / filter / group / `changesSince`), and the `CutLog` query interface.
 *
 * The server-side CAPTURE surface (`bindCapture`, `captureCut`) lives at the
 * `@here.build/plexus-history/capture` subpath — wired in LogDO, never a public capability.
 */
export type { Cut, PlexusChange, EntityRef, Verb, UserSession, StateVector, DeleteRanges } from "./types.js";
export { MissingStructError } from "./types.js";

export { changesBetween, changesByRef } from "./lift.js";
export { valueAsOf, valueAtRef, currentValue } from "./point-in-time.js";
export { ancestorChain, parentChain, resolveRef, isInSubtree, type ChainHop } from "./tree.js";
export { parseComboKey, type ComboKey, type ComboMember } from "./combo-key.js";
export { planRestore, type RestoreTarget } from "./restore.js";
export {
  filterBy,
  groupBy,
  subtreeScope,
  decorate,
  blame,
  changesSince,
  type ChangeFilter,
  type ChangeGroup,
  type SubtreeScopeOpts,
} from "./operators.js";
export { InMemoryCutLog, type CutLog, type CutRef } from "./cut-log.js";
