/**
 * Process-local plan-change signal (spec §4.1).
 * Not CRDT — claim owner subscribes and runs A3/reconcile after seed or plan edits.
 */

export type PlanChangedListener = () => void;

const listeners = new Set<PlanChangedListener>();

/** Subscribe to {@link notifyPlanChanged}. Returns unsubscribe. */
export function onPlanChanged(listener: PlanChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Plan author / seed path: fire process-local A3 signal. No-op if no listeners. */
export function notifyPlanChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}
