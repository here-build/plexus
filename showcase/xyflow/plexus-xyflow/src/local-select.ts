type Measured = { width: number; height: number };

type EditorNode = {
  id: string;
  selected?: boolean;
  measured?: { width?: number | null; height?: number | null };
  width?: number | null;
  height?: number | null;
};

/**
 * `selected` and `measured` are editor state. Snapshots from the graph never
 * carry them. xyflow's resizer reads `measured` and treats a missing width as
 * 0, so a fresh object on every change resizes from the position point and the
 * node jumps. A dimensions change in this batch wins; otherwise keep the
 * previous measurement when it still matches the model, and seed from the
 * model's width/height until the observer reports.
 */
export function mergeLocalSelect<T extends EditorNode>(
  snapshot: T[],
  previous: T[],
  changes: readonly {
    type: string;
    id?: string;
    selected?: boolean;
    dimensions?: { width: number; height: number };
  }[] = [],
): T[] {
  const selected = new Map(previous.map((item) => [item.id, item.selected ?? false]));
  const measured = new Map<string, Measured>();
  for (const item of previous) {
    const width = item.measured?.width;
    const height = item.measured?.height;
    if (item.id && typeof width === "number" && typeof height === "number") {
      measured.set(item.id, { width, height });
    }
  }
  for (const change of changes) {
    if (!change.id) continue;
    if (change.type === "select") selected.set(change.id, change.selected ?? false);
    if (change.type === "dimensions" && change.dimensions) measured.set(change.id, { ...change.dimensions });
  }
  return snapshot.map((item) => {
    const kept = measured.get(item.id);
    const next =
      kept && (kept.width === item.width || item.width == null) && (kept.height === item.height || item.height == null)
        ? kept
        : typeof item.width === "number" && typeof item.height === "number"
          ? { width: item.width, height: item.height }
          : kept;
    return { ...item, selected: selected.get(item.id) ?? false, ...(next ? { measured: next } : {}) };
  });
}
