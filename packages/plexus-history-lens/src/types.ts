import type { UserSession } from "@here.build/plexus-history";

import type { VarianceCoord } from "./variance.js";
import type { ComponentIntent } from "./areas/component.js";
import type { PageIntent } from "./areas/page.js";
import type { ParamsStatesTypesIntent } from "./areas/params-states-types.js";
import type { StylingIntent } from "./areas/styling.js";
import type { TokensIntent } from "./areas/tokens.js";
import type { TplTreeIntent } from "./areas/tpl-tree.js";
import type { BehaviorIntent } from "./areas/behavior.js";
import type { DataIntent } from "./areas/data.js";
import type { ProjectIntent } from "./areas/project.js";
import type { VariantsIntent } from "./areas/variants.js";

/**
 * Common envelope on every intent event (design §1). `seq` is the anchor cut; `seqs` is present when an
 * event is coalesced across a burst window (decision 2 — not yet wired). `sourceUuids` is the audit trail
 * back to the consolidated PlexusChange[] (drill-down / blame). Humanized `text` is derived by `humanize`,
 * not stored here.
 *
 * `object` / `coordinate` are the object-centric resolution (lens-architecture.md §1–4): the named subject
 * the event is ABOUT, and the typed variance coordinate it sits under. They are STAMPED by the pipeline when
 * {@link import("./consolidate.js").consolidate} is given the archive (it resolves the anchor change through
 * `resolveChange`); absent otherwise (the humanize-only path is unaffected). Pass 2 groups facet-events by
 * `(object, coordinate)` ({@link import("./narrate.js").narrate}).
 */
export interface IntentEventBase {
  seq: number;
  seqs?: number[];
  timestamp: number;
  author: UserSession | null;
  sourceUuids: string[];
  /** The named subject this event is about (resolved via `resolveChange`); absent when unresolved/archive-less. */
  object?: { uuid: string; type: string; name: string };
  /** The typed variance coordinate this change sits under (§3); absent for the base combo / a non-variance facet. */
  coordinate?: VarianceCoord;
}

/**
 * The total-coverage degrade: a change recognized structurally but without a dedicated intent yet. The
 * describing layer must be TOTAL (hardening) — it degrades, never silently drops. As more areas land,
 * RawEdits get promoted to real intents. (Unused by the toy scenario — everything there is recognized.)
 *
 * CENTRAL by design: not owned by any area — the pipeline's fallback when every area defers.
 */
export interface RawEdit extends IntentEventBase {
  kind: "RawEdit";
  entityType: string;
  entityLabel: string;
  field?: string;
  verb: string;
  before?: unknown;
  after?: unknown;
}

/**
 * The aggregate `IntentEvent` union. CENTRAL pieces (`IntentEventBase`, `RawEdit`) live here; every other
 * member is contributed by an {@link AreaModule} (the clay tenet — each area exports its own kind types,
 * this union just sums them). Add an area → add its `*Intent` to this union.
 */
export type IntentEvent =
  | ComponentIntent
  | PageIntent
  | TplTreeIntent
  | StylingIntent
  | TokensIntent
  | VariantsIntent
  | ParamsStatesTypesIntent
  | BehaviorIntent
  | DataIntent
  | ProjectIntent
  | RawEdit;
export type IntentKind = IntentEvent["kind"];
