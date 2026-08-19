import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Project / Site / Arenas   (design §1 "Project / Site / Arenas", §3 rows)
 * ─────────────────────────────────────────────────────────────────────────────
 * The top of the tree: the project itself, site-wide config (flags / dependencies /
 * diagnostics / role bindings), and the canvas arenas + artboards (frames).
 *
 * Entity types this area OWNS (class names verified against
 * public-packages/model/src/models/{global,component} this pass):
 *   - "ProjectPackage"  the doc root (name)
 *   - "Site"            site-wide config — flags/deps/diagnostics/roles live as RECORDS on it
 *   - "Arena"           a canvas arena (name, frames)
 *   - "ArenaFrame"      an artboard within an arena (name, position, size via FrameConfig)
 *
 * ── Flags ────────────────────────────────────────────────────────────────────
 *   - ProjectCreated is NOT emitted: ProjectPackage is the lift-skipped doc root (design §4 /
 *     hardening) — genesis is a host-resolver / t0-snapshot decision (decision 1, V's call). We
 *     handle ProjectRenamed (a `name` set on the materialized-at-genesis root, non-fresh later).
 *   - Site config (flags/dependencies/diagnostics/roleBindings/pageWrapper) are RECORD entries on
 *     Site → key-bearing sets (C2 now carries the entry key = the flag/dep name). We map the field
 *     to a subKind + surface the key as the label. The exact Site field names are per design §1 —
 *     verify vs Site.ts; an unmapped Site field falls through to a generic SiteConfigChanged.
 *   - Artboard "resized" may live on a child FrameConfig (width/height) rather than the ArenaFrame
 *     directly; both are handled (FrameConfig edits map here via the ArenaFrame owner is TODO —
 *     for now a FrameConfig set is RawEdit unless it surfaces as an ArenaFrame field).
 */

const stamp = (meta: CutMeta): Pick<IntentEventBase, "sourceUuids" | "seq" | "timestamp" | "author"> => ({
  sourceUuids: meta.sourceUuids,
  seq: meta.seq,
  timestamp: meta.timestamp,
  author: meta.author,
});

/** The project was renamed. */
export interface ProjectRenamed extends IntentEventBase {
  kind: "ProjectRenamed";
  from: string;
  to: string;
}

/** A canvas arena changed. */
export interface ArenaChanged extends IntentEventBase {
  kind: "ArenaChanged";
  subKind: "added" | "renamed" | "removed" | "reordered" | "edited";
  label: string;
}

/** An artboard (frame) within an arena changed. */
export interface ArtboardChanged extends IntentEventBase {
  kind: "ArtboardChanged";
  subKind: "added" | "renamed" | "moved" | "resized" | "removed" | "edited";
  label: string;
}

/** A site-wide config record entry changed (flag / dependency / diagnostic / role binding / page wrapper). */
export interface SiteConfigChanged extends IntentEventBase {
  kind: "SiteConfigChanged";
  subKind: "flag" | "dependency" | "diagnostic" | "roleBinding" | "pageWrapper" | "other";
  entryKey?: string; // the C2 entry key (flag name / dependency name / …)
  field: string;
}

export type ProjectIntent = ProjectRenamed | ArenaChanged | ArtboardChanged | SiteConfigChanged;

// Site record-field → SiteConfigChanged subKind. Field names per design §1 — verify vs Site.ts.
const SITE_FIELD_SUBKIND: Record<string, SiteConfigChanged["subKind"]> = {
  flags: "flag",
  featureFlags: "flag",
  dependencies: "dependency",
  projectDependencies: "dependency",
  diagnostics: "diagnostic",
  diagnosticsRuleset: "diagnostic",
  defaultComponents: "roleBinding",
  roleBindings: "roleBinding",
  pageWrapper: "pageWrapper",
};

export const projectArea: AreaModule = {
  name: "Project",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): ProjectIntent | null {
    if (root.entity.type === "Arena")
      return { kind: "ArenaChanged", subKind: "added", label: ctx.nameOf(root.entity.uuid, meta.seq) ?? "an arena", ...stamp(meta) };
    if (root.entity.type === "ArenaFrame")
      return { kind: "ArtboardChanged", subKind: "added", label: ctx.nameOf(root.entity.uuid, meta.seq) ?? "an artboard", ...stamp(meta) };
    return null;
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): ProjectIntent | null {
    const label = (fallback: string): string => ctx.nameOf(c.entity.uuid, meta.seq) ?? fallback;

    // Project rename (the doc root's name).
    if (c.verb === "set" && c.field === "name" && c.entity.type === "ProjectPackage") {
      return { kind: "ProjectRenamed", from: str(c.before), to: str(c.after), ...stamp(meta) };
    }

    // Arena lifecycle.
    if (c.entity.type === "Arena") {
      if (c.verb === "detach") return { kind: "ArenaChanged", subKind: "removed", label: label("an arena"), ...stamp(meta) };
      if (c.verb === "set" && c.field === "name") return { kind: "ArenaChanged", subKind: "renamed", label: label("an arena"), ...stamp(meta) };
      if (c.verb === "reorder") return { kind: "ArenaChanged", subKind: "reordered", label: label("an arena"), ...stamp(meta) };
      return { kind: "ArenaChanged", subKind: "edited", label: label("an arena"), ...stamp(meta) };
    }

    // Artboard (frame) lifecycle.
    if (c.entity.type === "ArenaFrame") {
      if (c.verb === "detach") return { kind: "ArtboardChanged", subKind: "removed", label: label("an artboard"), ...stamp(meta) };
      if (c.verb === "reparent") return { kind: "ArtboardChanged", subKind: "moved", label: label("an artboard"), ...stamp(meta) };
      if (c.verb === "set" && c.field === "name") return { kind: "ArtboardChanged", subKind: "renamed", label: label("an artboard"), ...stamp(meta) };
      if (c.verb === "set" && (c.field === "width" || c.field === "height")) return { kind: "ArtboardChanged", subKind: "resized", label: label("an artboard"), ...stamp(meta) };
      return { kind: "ArtboardChanged", subKind: "edited", label: label("an artboard"), ...stamp(meta) };
    }

    // Site-wide config records (key-bearing — C2 surfaces the entry key).
    if (c.entity.type === "Site" && c.field !== undefined && (c.verb === "set" || c.verb === "clear" || c.verb === "insert" || c.verb === "remove")) {
      return {
        kind: "SiteConfigChanged",
        subKind: SITE_FIELD_SUBKIND[c.field] ?? "other",
        ...(c.key !== undefined ? { entryKey: c.key } : {}),
        field: c.field,
        ...stamp(meta),
      };
    }
    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "ProjectRenamed":
        return `Renamed the project "${e.from}" → "${e.to}"`; // DRAFT — V review
      case "ArenaChanged":
        return e.subKind === "added"
          ? `Added arena "${e.label}"` // DRAFT — V review
          : e.subKind === "renamed"
            ? `Renamed arena "${e.label}"` // DRAFT — V review
            : e.subKind === "removed"
              ? `Removed arena "${e.label}"` // DRAFT — V review
              : `Changed arena "${e.label}" (${e.subKind})`; // DRAFT — V review
      case "ArtboardChanged":
        return e.subKind === "added"
          ? `Added artboard "${e.label}"` // DRAFT — V review
          : e.subKind === "resized"
            ? `Resized artboard "${e.label}"` // DRAFT — V review
            : `Changed artboard "${e.label}" (${e.subKind})`; // DRAFT — V review
      case "SiteConfigChanged": {
        const what = e.entryKey ? `"${e.entryKey}"` : e.field;
        switch (e.subKind) {
          case "flag":
            return `Changed site flag ${what}`; // DRAFT — V review
          case "dependency":
            return `Changed dependency ${what}`; // DRAFT — V review
          case "diagnostic":
            return `Changed a diagnostics rule ${what}`; // DRAFT — V review
          case "roleBinding":
            return `Changed a component role binding ${what}`; // DRAFT — V review
          case "pageWrapper":
            return `Changed the page wrapper`; // DRAFT — V review
          default:
            return `Changed site config (${e.field})`; // DRAFT — V review
        }
      }
      default:
        return null;
    }
  },
};

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
