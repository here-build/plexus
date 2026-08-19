import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Area: Data / Queries / Operations / Integrations & Collaboration  (design §1, §3)
 * ─────────────────────────────────────────────────────────────────────────────
 * The data plane + collaboration: data sources, queries, callable operations, code/npm
 * imports, A/B splits, and comments. The widest area — most members are the generic
 * lifecycle shape (birth → add, set → edit/relabel, detach → removed); Comment is the
 * one with a real subKind alphabet (post/react/resolve/…).
 *
 * Entity types this area OWNS (class names verified against
 * public-packages/model/src/models/{queries,operations,comments,split-content} this pass):
 *   - "DataSourceDefinition" / "DataSourceDefinitionCustomType" / "DataQueryFetch" / "ProviderSource"
 *   - "ComponentDataQuery"  (a query)            - "ValueOperation" / "InvokeOperation"  (operations)
 *   - "ImportSpec" / "NpmPackage" / "NpmExportSource" / "CodeLibrary"  (imports)
 *   - "Split" / "RandomSplitSlice" / "SegmentSplitSlice"  (A/B splits)
 *   - "Comment" / "CommentsPackage"  (collaboration)
 *
 * ── Pipeline framing ─────────────────────────────────────────────────────────
 * These are top-level (Site/Project-owned) entities → a materialize is a BIRTH ROOT
 * (the Site is not fresh) → recognizeBirth. Their internal config cascade is fresh
 * descendants → absorbed. recognizeEdit sees edits to existing ones + detaches.
 *
 * ── Flags ────────────────────────────────────────────────────────────────────
 *   - ProjectVariable is NOT a confirmed standalone class (likely a record on Site) — left
 *     to RawEdit until its carrier is verified (key-gated set, needs C2 key).
 *   - Comment author/anchor resolution is an INJECTED cross-doc resolver (design §1.2); we
 *     surface the structural subKind, the author/anchor labels are the host's to fill.
 *   - The rich DataSource/Query/Operation subKind alphabets (chain / set-invalidation /
 *     bind-source / …) collapse to add/edited/removed here; promote in a feedback pass.
 */

type Lifecycle = "DataSourceChanged" | "QueryChanged" | "OperationChanged" | "ImportChanged" | "SplitChanged";

// entity.type → which lifecycle intent it maps to (the "root" entity of each family).
const LIFECYCLE_OF: Record<string, Lifecycle> = {
  DataSourceDefinition: "DataSourceChanged",
  DataSourceDefinitionCustomType: "DataSourceChanged",
  DataQueryFetch: "DataSourceChanged",
  ProviderSource: "DataSourceChanged",
  ComponentDataQuery: "QueryChanged",
  ValueOperation: "OperationChanged",
  InvokeOperation: "OperationChanged",
  ImportSpec: "ImportChanged",
  NpmPackage: "ImportChanged",
  NpmExportSource: "ImportChanged",
  CodeLibrary: "ImportChanged",
  Split: "SplitChanged",
  RandomSplitSlice: "SplitChanged",
  SegmentSplitSlice: "SplitChanged",
};

const COMMENT_TYPES = new Set(["Comment", "CommentsPackage"]);

const stamp = (meta: CutMeta): Pick<IntentEventBase, "sourceUuids" | "seq" | "timestamp" | "author"> => ({
  sourceUuids: meta.sourceUuids,
  seq: meta.seq,
  timestamp: meta.timestamp,
  author: meta.author,
});

/** A data-plane entity (source / query / operation / import / split) was added, edited, or removed. */
export interface DataEntityChanged extends IntentEventBase {
  kind: Lifecycle;
  subKind: "add" | "edited" | "relabel" | "removed";
  label: string;
}

/** A collaboration comment event. authorLabel/anchorSummary are filled by the host's injected resolver. */
export interface CommentEvent extends IntentEventBase {
  kind: "CommentEvent";
  subKind: "post" | "react" | "resolve" | "edit" | "removed";
  label: string;
}

export type DataIntent = DataEntityChanged | CommentEvent;

const labelOf = (ctx: LensCtx, c: PlexusChange, seq: number): string => ctx.nameOf(c.entity.uuid, seq) ?? c.entity.type;

export const dataArea: AreaModule = {
  name: "Data",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): DataIntent | null {
    if (COMMENT_TYPES.has(root.entity.type)) {
      return { kind: "CommentEvent", subKind: "post", label: ctx.nameOf(root.entity.uuid, meta.seq) ?? "a comment", ...stamp(meta) };
    }
    const lc = LIFECYCLE_OF[root.entity.type];
    if (!lc) return null;
    return { kind: lc, subKind: "add", label: ctx.nameOf(root.entity.uuid, meta.seq) ?? root.entity.type, ...stamp(meta) };
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): DataIntent | null {
    // Comment edits: resolve (a `resolved` flag flip), react (a reactions record entry), edit (body), remove.
    if (COMMENT_TYPES.has(c.entity.type)) {
      const subKind =
        c.verb === "detach" || c.verb === "remove"
          ? "removed"
          : c.verb === "set" && (c.field === "resolved" || c.field === "resolvedAt")
            ? "resolve"
            : c.verb === "set" && c.field === "reactions"
              ? "react"
              : "edit";
      return { kind: "CommentEvent", subKind, label: ctx.nameOf(c.entity.uuid, meta.seq) ?? "a comment", ...stamp(meta) };
    }
    const lc = LIFECYCLE_OF[c.entity.type];
    if (!lc) return null;
    if (c.verb === "detach") return { kind: lc, subKind: "removed", label: labelOf(ctx, c, meta.seq), ...stamp(meta) };
    if (c.verb === "set" && (c.field === "name" || c.field === "label"))
      return { kind: lc, subKind: "relabel", label: labelOf(ctx, c, meta.seq), ...stamp(meta) };
    if (c.verb === "set" || c.verb === "clear" || c.verb === "insert" || c.verb === "remove")
      return { kind: lc, subKind: "edited", label: labelOf(ctx, c, meta.seq), ...stamp(meta) };
    return null;
  },

  humanize(e): string | null {
    if (e.kind === "CommentEvent") {
      switch (e.subKind) {
        case "post":
          return `Posted a comment`; // DRAFT — V review (host injects author)
        case "react":
          return `Reacted to a comment`; // DRAFT — V review
        case "resolve":
          return `Resolved a comment thread`; // DRAFT — V review
        case "edit":
          return `Edited a comment`; // DRAFT — V review
        case "removed":
          return `Deleted a comment`; // DRAFT — V review
      }
    }
    const NOUN: Record<Lifecycle, string> = {
      DataSourceChanged: "data source",
      QueryChanged: "query",
      OperationChanged: "operation",
      ImportChanged: "import",
      SplitChanged: "split",
    };
    if (e.kind in NOUN) {
      const noun = NOUN[e.kind as Lifecycle];
      const ev = e as DataEntityChanged;
      switch (ev.subKind) {
        case "add":
          return `Added ${noun} "${ev.label}"`; // DRAFT — V review
        case "relabel":
          return `Renamed ${noun} "${ev.label}"`; // DRAFT — V review
        case "removed":
          return `Removed ${noun} "${ev.label}"`; // DRAFT — V review
        default:
          return `Edited ${noun} "${ev.label}"`; // DRAFT — V review
      }
    }
    return null;
  },
};
