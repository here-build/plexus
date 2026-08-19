import { PlexusModel, syncing } from "@here.build/plexus";

@syncing("Point")
export class Point extends PlexusModel {
  @syncing accessor x = 0;
  @syncing accessor y = 0;
}

/** Reuse vertex identity across ingest ticks — do not replace the list. */
export function writePoints(list: Point[], tuples: readonly (readonly number[])[]): void {
  while (list.length > tuples.length) list.pop();
  for (let i = 0; i < tuples.length; i++) {
    const x = tuples[i]![0]!;
    const y = tuples[i]![1]!;
    const existing = list[i];
    if (!existing) {
      const p = new Point();
      p.x = x;
      p.y = y;
      list.push(p);
    } else {
      existing.x = x;
      existing.y = y;
    }
  }
}
