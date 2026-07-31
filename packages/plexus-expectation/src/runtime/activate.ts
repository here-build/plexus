/**
 * activate(E) — claim-owner activation order (§5.3).
 *
 * Durable `running` + `bumpEpoch` BEFORE startResolver so early sync emits
 * (T19) and epoch fences (T4) are well-defined.
 */

import type { Expectation } from "../app/expectation.js";
import { isTerminal } from "../app/lifecycle.js";

import { applyEmit } from "./emit.js";
import { isRebindExhausted } from "./liveness.js";
import type { Orchestrator } from "./orchestrator.js";
import { planResolution } from "./plan-resolution.js";
import {
  handleFromController,
  snapshotDefinition,
  type ResolverHandle,
  type StartResolverFn,
} from "./resolver.js";
import { transactEntity } from "./transact.js";

/** Bump bindEpoch by 1 in the current transaction context; return new value. */
export function bumpEpoch(E: Expectation): number {
  E.bindEpoch += 1;
  return E.bindEpoch;
}

/**
 * Activate a single Expectation. Single-flight via `activating` set.
 * Idempotent for healthy running binds.
 *
 * From `awaiting_rebind`: if `rebindCount > MAX_REBINDS` → `failed` (rebind_exhausted).
 */
export function activate(orch: Orchestrator, E: Expectation): void {
  if (isTerminal(E.state)) return;
  // Lease / dual-claim gate (§2.2 / PR-9): observe-only and dual claim-owner
  // peers must not start resolvers. settleSurface already uses the same gate.
  if (!orch.isClaimOwner()) return;
  if (orch.activating.has(E)) return;

  const existing = orch.binding.get(E);
  if (E.state === "running" && existing && isHealthy(existing)) return;

  // §5.7 — unexpected rebind budget exhausted
  if (isRebindExhausted(E, orch.maxRebinds)) {
    transactEntity(E, () => {
      if (E.state === "awaiting_rebind") {
        E.transitionState("failed");
      }
    });
    orch.clearBind(E);
    orch.publishAwarenessBinds();
    return;
  }

  orch.activating.add(E);
  try {
    const outcome = planResolution(E, orch.getOrchestration(), orch.getLoadedModules());

    if (outcome.status === "missing") {
      // Cancel may have raced into activating — don't leave terminal
      if (isTerminal(E.state)) return;
      transactEntity(E, () => {
        if (!isTerminal(E.state)) E.transitionState("missing");
      });
      return;
    }
    if (outcome.status === "refused") {
      if (isTerminal(E.state)) return;
      transactEntity(E, () => {
        if (!isTerminal(E.state)) E.transitionState("refused");
      });
      return;
    }

    const def = outcome.def;

    // Mid-activate cancel (T23): durable already cancelled → stop
    if (isTerminal(E.state)) return;

    // Durable running + epoch BEFORE any resolver body (law 4 / T19)
    let epoch = 0;
    transactEntity(E, () => {
      if (isTerminal(E.state)) return;
      epoch = bumpEpoch(E);
      E.transitionState("running");
    });

    // Cancel raced into the durable write window
    if (E.state !== "running" || epoch === 0) return;

    if (def.launchMode === "surface") {
      const controller = new AbortController();
      const surfaceWait = handleFromController(controller);
      orch.setBind(E, { handle: surfaceWait, epoch });
      orch.publishAwarenessBinds();
      return;
    }

    // Placeholder bind so cancel during start can still abort the signal we create next
    const controller = new AbortController();
    const provisional = handleFromController(controller);
    orch.setBind(E, { handle: provisional, epoch });
    orch.publishAwarenessBinds();

    const startFn = orch.resolveModule(E.kind, def.launchMode);
    if (!startFn) {
      failStart(orch, E, controller);
      return;
    }

    try {
      const handle = startResolver(orch, E, {
        startFn,
        epoch,
        def,
        controller,
        provisional,
      });
      // Only keep bind if still running at this epoch (sync complete may have settled)
      const bind = orch.binding.get(E);
      if (bind && bind.epoch === epoch && E.state === "running") {
        orch.setBind(E, { handle: handle ?? provisional, epoch });
      }
    } catch {
      failStart(orch, E, controller);
    }
  } finally {
    orch.clearActivating(E);
  }
}

function failStart(orch: Orchestrator, E: Expectation, controller: AbortController): void {
  if (!controller.signal.aborted) {
    controller.abort("start_failed");
  }
  orch.clearBind(E);
  orch.publishAwarenessBinds();
  if (!isTerminal(E.state)) {
    transactEntity(E, () => {
      if (!isTerminal(E.state)) E.transitionState("failed");
    });
  }
}

function startResolver(
  orch: Orchestrator,
  E: Expectation,
  args: {
    startFn: StartResolverFn;
    epoch: number;
    def: Parameters<typeof snapshotDefinition>[0];
    controller: AbortController;
    provisional: ResolverHandle;
  },
): ResolverHandle {
  const { startFn, epoch, def, controller, provisional } = args;

  const input = {
    work: workIdentity(E),
    epoch,
    definition: snapshotDefinition(def),
    input: orch.snapshotProductFields(E),
    signal: controller.signal,
  };

  // Emit closed over E + orch; no re-entrant activate on same E from this path
  const emit = (message: Parameters<typeof applyEmit>[2]) => {
    applyEmit(orch, E, message);
  };

  const returned = startFn(input, emit);

  // Sync start only for PR-3 (async modules: host may wrap; Promise return is out of scope)
  if (isThenable(returned)) {
    throw new Error("startResolver must return synchronously in first slice (no Promise handle)");
  }

  return returned ?? provisional;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function workIdentity(E: Expectation): { uuid: string; kind: string } {
  let uuid: string;
  try {
    uuid = E.uuid;
  } catch {
    // Unmaterialized entity (unit tests / pre-attach): localID is process-stable
    uuid = `local:${E.localID}`;
  }
  return { uuid, kind: E.kind };
}

function isHealthy(bind: { handle: ResolverHandle | null; epoch: number }): boolean {
  if (bind.handle == null) return true;
  return !bind.handle.aborted;
}
