/**
 * Process-local plan-change signal (spec §4.1).
 * Not CRDT — claim owner may subscribe and run plan-change reconcile after seed
 * or plan edits. Not exported from the orchestration barrel by default: hosts
 * that react over `Orchestration.actors` do not need this channel.
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

/** Plan author / seed path: fire process-local plan-change signal. No-op if no listeners. */
export function notifyPlanChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}
