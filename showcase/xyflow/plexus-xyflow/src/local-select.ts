/**
 * `selected` is editor state. Snapshots from the graph never carry it.
 * Remote updates keep the previous flags; `select` changes rewrite them.
 * Restoring previous flags after a click is what makes selection look dead.
 */
export function mergeLocalSelect<T extends { id: string; selected?: boolean }>(
  snapshot: T[],
  previous: T[],
  changes: readonly { type: string; id?: string; selected?: boolean }[] = [],
): T[] {
  const selected = new Map(previous.map((item) => [item.id, item.selected ?? false]));
  for (const change of changes) {
    if (change.type === "select" && change.id) selected.set(change.id, change.selected ?? false);
  }
  return snapshot.map((item) => ({ ...item, selected: selected.get(item.id) ?? false }));
}
