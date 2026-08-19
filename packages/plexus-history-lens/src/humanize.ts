import { AREAS } from "./registry.js";
import type { IntentEvent, RawEdit } from "./types.js";

/**
 * IntentEvent → one human-readable line. NO raw uuids ever (names are pre-resolved in the event). Dispatch
 * is over the {@link AREAS} registry (each area renders its own kinds; first non-null wins) then the CENTRAL
 * `RawEdit` fallback — the clay tenet, mirroring the recognition dispatch in {@link consolidate}.
 *
 * ★ Every string below is DRAFT — V REVIEW. The STRUCTURE (which event, what fields it carries) is
 * settled; the exact wording is V's taste call (V: "plain English mode clearly needs review").
 */
export function humanizeOne(e: IntentEvent): string {
  for (const area of AREAS) {
    const line = area.humanize(e);
    if (line !== null) return line;
  }
  // The CENTRAL total-coverage degrade — owned by no area (promoted to real intents as areas land).
  return rawEditLine(e as RawEdit); // DRAFT — V review
}

function rawEditLine(e: RawEdit): string {
  const what = e.field ?? e.verb;
  return `Changed ${e.entityLabel} (${what})`; // DRAFT — V review
}

/** The annotation: one line per event (the GitHub-action-comment shape). */
export function humanize(events: IntentEvent[]): string {
  return events.map(humanizeOne).join("\n");
}
