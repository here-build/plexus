/**
 * Live handle for a launched Expectation — generalized API for every plan.
 *
 * Claim-owner holds this in the bind map. Body uses emit/control; host uses
 * abort + adjustment ingress.
 *
 * LaunchRuntime is process-local (Fable H3) — not methods on CRDT LaunchDefinition.
 * Host-port path keeps StartResolverFn factories (H1); pure runners use explicit
 * import() inside bootstrap only (no durable importPath — H4).
 */
import type { LaunchDefinition, LaunchDefinitionSnapshot } from "../orchestration/launch-definition.js";
import type {
  AdjustmentSnapshot,
  ControlAckFn,
  EmitFn,
  ResolverControlAck,
  ResolverEmit,
  ResolverHandle,
  StartResolverFn,
} from "./resolver.js";

export type LaunchContext = {
  readonly kind: string;
  readonly epoch: number;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly definition: LaunchDefinitionSnapshot;
};

export type ExecutionSinks = {
  readonly applyEmit: (message: ResolverEmit) => void;
  readonly applyControl: (ack: ResolverControlAck) => void;
};

/**
 * Full live API for one activation.
 */
export type ExpectationExecution = {
  readonly aborted: boolean;
  abort(reason?: unknown): void;
  emit(message: ResolverEmit): Promise<void>;
  control(ack: ResolverControlAck): Promise<void>;
  deliverAdjustment?(snapshot: AdjustmentSnapshot): void;
  retractAdjustment?(
    key: { intentId: string } | { adjustmentUuid: string },
    reshapeEpoch: number,
  ): void;
  reshapeAdjustment?(snapshot: AdjustmentSnapshot): void;
};

/**
 * Process-local launcher (claim-owner only).
 */
export type LaunchRuntime = {
  bootstrap(def: LaunchDefinition): Promise<void>;
  isReady(def: LaunchDefinition): boolean;
  /**
   * Whether a starter exists for this kind — if false, activate waits
   * (no beginRunning). Host-port: starter map; pure runners: ready after bootstrap.
   */
  canRun(def: LaunchDefinition, kind: string): boolean;
  /** Sync start — returns handle immediately. */
  run(def: LaunchDefinition, ctx: LaunchContext, sinks: ExecutionSinks): ExpectationExecution;
};

/**
 * Wrap legacy StartResolverFn as ExpectationExecution (host-port migration path).
 */
export function executionFromStartResolver(
  startFn: StartResolverFn,
  ctx: LaunchContext,
  sinks: ExecutionSinks,
  provisional?: ResolverHandle,
): ExpectationExecution {
  const emit: EmitFn = (message) => {
    sinks.applyEmit(message);
  };
  const control: ControlAckFn = (ack) => {
    sinks.applyControl(ack);
  };

  const started =
    startFn(
      {
        kind: ctx.kind,
        epoch: ctx.epoch,
        definition: ctx.definition,
        input: ctx.input,
        signal: ctx.signal,
      },
      emit,
      control,
    ) ?? provisional;

  const handle: ResolverHandle = started ?? {
    get aborted() {
      return ctx.signal.aborted;
    },
    abort() {
      /* no-op */
    },
  };

  return {
    get aborted() {
      return handle.aborted;
    },
    abort(reason?: unknown) {
      handle.abort(reason);
    },
    async emit(message: ResolverEmit) {
      sinks.applyEmit(message);
    },
    async control(ack: ResolverControlAck) {
      sinks.applyControl(ack);
    },
    deliverAdjustment: handle.deliverAdjustment?.bind(handle),
    retractAdjustment: handle.retractAdjustment?.bind(handle),
    reshapeAdjustment: handle.reshapeAdjustment?.bind(handle),
  };
}

/**
 * Host-port runtime: kind → StartResolverFn (session tool/completion ports).
 * bootstrap is a no-op; always ready.
 */
export class HostPortLaunchRuntime implements LaunchRuntime {
  constructor(
    private readonly resolveStart: (def: LaunchDefinition, ctx: LaunchContext) => StartResolverFn | undefined,
    private readonly provisionalFromSignal: (signal: AbortSignal) => ResolverHandle,
  ) {}

  async bootstrap(_def: LaunchDefinition): Promise<void> {
    /* host ports already wired */
  }

  isReady(_def: LaunchDefinition): boolean {
    return true;
  }

  canRun(def: LaunchDefinition, kind: string): boolean {
    return (
      this.resolveStart(def, {
        kind,
        epoch: 0,
        input: null,
        signal: new AbortController().signal,
        definition: def.toSnapshot(),
      }) != null
    );
  }

  run(def: LaunchDefinition, ctx: LaunchContext, sinks: ExecutionSinks): ExpectationExecution {
    const startFn = this.resolveStart(def, ctx);
    if (!startFn) {
      throw new Error(`HostPortLaunchRuntime: no starter for kind ${ctx.kind}`);
    }
    const fullCtx: LaunchContext = { ...ctx, definition: def.toSnapshot() };
    return executionFromStartResolver(
      startFn,
      fullCtx,
      sinks,
      this.provisionalFromSignal(ctx.signal),
    );
  }
}
