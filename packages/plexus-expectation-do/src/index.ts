/**
 * PEW × Durable Objects — the CF-host adapter surface.
 *
 * Stage 1: `installKernel` mounts the real PEW kernel (`Orchestrator`, from
 * `@here.build/plexus-expectation/executor`) over host-injected ports,
 * mirrors every durable envelope write into `opts.storage` in the same
 * synchronous turn as the in-memory CRDT apply (proposal §3 durability
 * gate), wires DO alarms to `reconcile()` (proposal §9), and implements the
 * dispose fold (proposal §1, finding G6). See `kernel.ts` for the
 * implementation and its documented Stage 1 gaps (presence-hub wiring,
 * forest-orphan candidates, dual-claim detection).
 *
 * Stage 2: `DurableObjectLoader` (the cross-DO relay adapter, proposal §5) —
 * synchronous spawn with explicit `waitUntil` retention (G2), one-way cancel
 * (G5), a kernel-side relay buffer fed in the frame-decode turn (G7/LC4),
 * and the actor-DO lifetime protocol (G4/G12/LC5): `kernel.ts` records the
 * actor-DO name durably alongside `processorClientId` and reconcile sweeps
 * recorded names for terminal-with-possibly-live-actor, re-issuing
 * `terminate` — never trusting self-termination alone. See
 * `actor-do-loader.ts` for the implementation and the filled contract gap
 * (DO-relayed triads must carry their own uuid in `snapshotInput()`).
 *
 * Stage 3: `InProcessLoader` (the in-process host-surface base, proposal §7
 * G15/G16 + §8 G10) — the declare port (an actor REQUESTS a child; the HOST
 * authors the mint transactionally in `DoOrchestrator#mintDeclaredChild`;
 * the kernel activates it on the next reconcile) and real presence-hub
 * wiring (every spawn mints exactly one client via `InstallOpts#presence`,
 * synchronously, before `processorClientId` is read — see `in-process-loader.ts`
 * for why the loader, not the kernel, is the seam that can override `ctx`).
 * `InstallOpts#childFactories` fills the kind → Expectation-constructor gap
 * the proposal left open. Scope note: this wiring covers loaders that extend
 * `InProcessLoader`; `DurableObjectLoader`-spawned (cross-DO) actors are
 * unaffected (non-goal — proposal §11).
 *
 * Design authority: `inhuman/docs/working-proposals/2026-08-03-pew-do-integration.md`
 * (v2, reviewed); PEW semantics defer to `@here.build/plexus-expectation/docs/design.md`.
 *
 * The surface is PORT-BASED on purpose (see `ports.ts`): the kernel touches
 * the platform only through injected ports, so the host matrix runs against
 * in-memory fakes in plain node, and only true platform-gate semantics
 * (output-gate write visibility, real eviction) need a workerd pool later.
 */

export { UnimplementedError } from "./errors.js";

export {
  type AlarmPort,
  type ChildFactoryRegistry,
  type DeclarePort,
  type InstallOpts,
  type KernelHandle,
  type LauncherRootLike,
  type PresenceHubPort,
  type SessionRootLike,
  type StoragePort,
  type WaitUntilPort,
} from "./ports.js";

export { installKernel } from "./kernel.js";

export {
  type ActorDoInvokeRequest,
  type ActorDoNamespacePort,
  type RelayFrame,
  deriveActorDoName,
  DurableObjectLoader,
} from "./actor-do-loader.js";

export { InProcessLoader, type DoHostBinding, type DoLaunchContext, type MintChildFn } from "./in-process-loader.js";
