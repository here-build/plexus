import type { PlexusChange } from "@here.build/plexus-history";

const str = (v: unknown): string => (v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v));

/**
 * Render one decorated change as a human-readable line — the GitHub-action-comment shape.
 * `entity.label` is filled by the product's `decorate(...)` resolver (here: the model's name).
 */
export function annotateOne(c: PlexusChange): string {
  const label = c.entity.label ?? c.entity.type;
  switch (c.verb) {
    case "materialized":
      return `+ ${c.entity.type} '${label}'`;
    case "detach":
      return `− ${c.entity.type} '${label}'`;
    case "reparent":
      return `${c.entity.type} '${label}' moved → ${c.to?.label ?? c.to?.type ?? "?"}`;
    case "set":
      return c.field === "name"
        ? `${c.entity.type} renamed '${str(c.before)}' → '${str(c.after)}'`
        : `${c.entity.type} '${label}' ${c.field}: ${str(c.before)} → ${str(c.after)}`;
    case "clear":
      return `${c.entity.type} '${label}' ${c.field} cleared`;
    case "insert":
      return `${c.entity.type} '${label}' ${c.field} + ${str(c.after)}`;
    case "remove":
      return `${c.entity.type} '${label}' ${c.field} − ${str(c.before)}`;
    case "reorder":
      return `${c.entity.type} '${label}' ${c.field} reordered`;
  }
}

export function annotate(changes: PlexusChange[]): string {
  return changes.map(annotateOne).join("\n");
}
