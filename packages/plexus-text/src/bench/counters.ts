/**
 * Dev/bench model counters for the membrane performance suite.
 * See docs/working-proposals/plexustext-perf-stress-tests.md §2.2, §7.1.
 * E1 firing counters: pulls, projectionKeyCalls (Wave 0 of non-freezing DAG).
 *
 * When `C.on` is false, hot paths only pay a monomorphic property load + predicted branch.
 */

export type ModelCounters = {
  on: boolean;
  toText: number;
  segments: number;
  spansOfType: number;
  listIndexAtOffset: number;
  nodesScanned: number;
  atomsCreated: number;
  markersCreated: number;
  marksCreated: number;
  spliceCalls: number;
  spliceElements: number;
  actionsOpened: number;
  /** Times the binding entered pull / pullMinimal (after applying guard). */
  pulls: number;
  /** Times the MobX tracking function (projectionKey / toText reaction expr) ran. */
  projectionKeyCalls: number;
  /** Times an inbound signal was absorbed into an already-scheduled coalesce. */
  coalesceScheduled: number;
  /** P1: individual TextEvent items delivered to handlers. */
  p1Events: number;
  /** P1: resync events (geometry desync → P0 fallback). */
  p1Resyncs: number;
};

export const C: ModelCounters = {
  on: false,
  toText: 0,
  segments: 0,
  spansOfType: 0,
  listIndexAtOffset: 0,
  nodesScanned: 0,
  atomsCreated: 0,
  markersCreated: 0,
  marksCreated: 0,
  spliceCalls: 0,
  spliceElements: 0,
  actionsOpened: 0,
  pulls: 0,
  projectionKeyCalls: 0,
  coalesceScheduled: 0,
  p1Events: 0,
  p1Resyncs: 0,
};

export function resetCounters(): void {
  C.toText = 0;
  C.segments = 0;
  C.spansOfType = 0;
  C.listIndexAtOffset = 0;
  C.nodesScanned = 0;
  C.atomsCreated = 0;
  C.markersCreated = 0;
  C.marksCreated = 0;
  C.spliceCalls = 0;
  C.spliceElements = 0;
  C.actionsOpened = 0;
  C.pulls = 0;
  C.projectionKeyCalls = 0;
  C.coalesceScheduled = 0;
  C.p1Events = 0;
  C.p1Resyncs = 0;
}

export function snapshotCounters(): Readonly<Omit<ModelCounters, "on">> {
  return {
    toText: C.toText,
    segments: C.segments,
    spansOfType: C.spansOfType,
    listIndexAtOffset: C.listIndexAtOffset,
    nodesScanned: C.nodesScanned,
    atomsCreated: C.atomsCreated,
    markersCreated: C.markersCreated,
    marksCreated: C.marksCreated,
    spliceCalls: C.spliceCalls,
    spliceElements: C.spliceElements,
    actionsOpened: C.actionsOpened,
    pulls: C.pulls,
    projectionKeyCalls: C.projectionKeyCalls,
    coalesceScheduled: C.coalesceScheduled,
    p1Events: C.p1Events,
    p1Resyncs: C.p1Resyncs,
  };
}

export function diffCounters(
  before: Readonly<Omit<ModelCounters, "on">>,
  after: Readonly<Omit<ModelCounters, "on">>,
): Readonly<Omit<ModelCounters, "on">> {
  return {
    toText: after.toText - before.toText,
    segments: after.segments - before.segments,
    spansOfType: after.spansOfType - before.spansOfType,
    listIndexAtOffset: after.listIndexAtOffset - before.listIndexAtOffset,
    nodesScanned: after.nodesScanned - before.nodesScanned,
    atomsCreated: after.atomsCreated - before.atomsCreated,
    markersCreated: after.markersCreated - before.markersCreated,
    marksCreated: after.marksCreated - before.marksCreated,
    spliceCalls: after.spliceCalls - before.spliceCalls,
    spliceElements: after.spliceElements - before.spliceElements,
    actionsOpened: after.actionsOpened - before.actionsOpened,
    pulls: after.pulls - before.pulls,
    projectionKeyCalls: after.projectionKeyCalls - before.projectionKeyCalls,
    coalesceScheduled: after.coalesceScheduled - before.coalesceScheduled,
    p1Events: after.p1Events - before.p1Events,
    p1Resyncs: after.p1Resyncs - before.p1Resyncs,
  };
}

/** Run `fn` with counters on; return result + delta. Restores previous `C.on`. */
export function withCounterWindow<T>(fn: () => T): {
  value: T;
  delta: Readonly<Omit<ModelCounters, "on">>;
} {
  const prev = C.on;
  C.on = true;
  const before = snapshotCounters();
  try {
    const value = fn();
    const after = snapshotCounters();
    return { value, delta: diffCounters(before, after) };
  } finally {
    C.on = prev;
  }
}
