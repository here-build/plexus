import type { AreaModule } from "./area.js";
import { componentArea } from "./areas/component.js";
import { pageArea } from "./areas/page.js";
import { paramsStatesTypesArea } from "./areas/params-states-types.js";
import { stylingArea } from "./areas/styling.js";
import { tokensArea } from "./areas/tokens.js";
import { tplTreeArea } from "./areas/tpl-tree.js";
import { behaviorArea } from "./areas/behavior.js";
import { dataArea } from "./areas/data.js";
import { projectArea } from "./areas/project.js";
import { variantsArea } from "./areas/variants.js";

/**
 * The clay registry: every here.build model AREA as a pluggable {@link AreaModule}. The CENTRAL pipeline
 * ({@link consolidate}) and {@link humanize} both dispatch over this list — first non-null wins. Adding an
 * area is one import + one entry here (plus its `*Intent` in the {@link IntentEvent} union). ORDER is
 * priority for `recognizeBirth`/`recognizeEdit` (the first area that claims a change owns it). ★Variants
 * MUST precede params-states-types — it folds co-fresh variant-subject States before params claims them.
 */
export const AREAS: AreaModule[] = [
  componentArea,
  pageArea,
  tplTreeArea,
  stylingArea,
  tokensArea,
  variantsArea,
  paramsStatesTypesArea,
  behaviorArea,
  dataArea,
  projectArea,
];
