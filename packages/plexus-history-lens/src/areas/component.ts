import type { PlexusChange } from "@here.build/plexus-history";

import type { AreaModule, CutMeta, LensCtx } from "../area.js";
import type { IntentEventBase } from "../types.js";

/** A component/page was created (the materialize-cascade collapsed to one event — the flagship). */
export interface ComponentAdded extends IntentEventBase {
  kind: "ComponentAdded";
  componentType: "component" | "page";
  name: string;
}

/** A component/page was renamed. */
export interface ComponentRenamed extends IntentEventBase {
  kind: "ComponentRenamed";
  from: string;
  to: string;
}

/** A component/page was removed (detached from its owner). */
export interface ComponentRemoved extends IntentEventBase {
  kind: "ComponentRemoved";
  name: string;
}

/** Every intent kind the Component area owns. */
export type ComponentIntent = ComponentAdded | ComponentRenamed | ComponentRemoved;

// here.build top-level component entity types. NOT TplComponent (a tpl-tree node, an instance).
const COMPONENT_TYPES = new Set(["PlainComponent", "PageComponent", "FrameComponent"]);
const isComponentType = (t: string): boolean => COMPONENT_TYPES.has(t);

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

/**
 * The Component area — top-level component lifecycle (add / rename / remove). One of the TWO TEMPLATE
 * modules (with {@link pageArea}) the fan-out copies. Owns component-typed births and the name/detach edits.
 */
export const componentArea: AreaModule = {
  name: "Component",

  recognizeBirth(root: PlexusChange, ctx: LensCtx, meta: CutMeta): ComponentAdded | null {
    if (!isComponentType(root.entity.type)) return null;
    return {
      kind: "ComponentAdded",
      componentType: root.entity.type === "PageComponent" ? "page" : "component",
      name: ctx.nameOf(root.entity.uuid, meta.seq) ?? "?",
      sourceUuids: meta.sourceUuids,
      seq: meta.seq,
      timestamp: meta.timestamp,
      author: meta.author,
    };
  },

  recognizeEdit(c: PlexusChange, ctx: LensCtx, meta: CutMeta): ComponentRenamed | ComponentRemoved | null {
    // Component / page rename.
    if (c.verb === "set" && c.field === "name" && isComponentType(c.entity.type)) {
      return {
        kind: "ComponentRenamed",
        from: str(c.before),
        to: str(c.after),
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }
    // Component / page removal.
    if (c.verb === "detach" && isComponentType(c.entity.type)) {
      return {
        kind: "ComponentRemoved",
        name: ctx.nameOf(c.entity.uuid, meta.seq) ?? "?",
        sourceUuids: meta.sourceUuids,
        seq: meta.seq,
        timestamp: meta.timestamp,
        author: meta.author,
      };
    }
    return null;
  },

  humanize(e): string | null {
    switch (e.kind) {
      case "ComponentAdded":
        return e.componentType === "page" ? `Added page "${e.name}"` : `Added component "${e.name}"`; // DRAFT — V review
      case "ComponentRenamed":
        return `Renamed component "${e.from}" → "${e.to}"`; // DRAFT — V review
      case "ComponentRemoved":
        return `Removed component "${e.name}"`; // DRAFT — V review
      default:
        return null;
    }
  },
};
