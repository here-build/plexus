import type { Expectation, LaunchDefinition } from "@here.build/plexus-expectation";

/**
 * Host ports (proposal §2 InstallOpts, §3 durability gate, §5 retention).
 *
 * The kernel touches the platform only through these injected ports, so the
 * DO host matrix runs against in-memory fakes in plain node — only true
 * platform-gate semantics (output-gate write visibility, real eviction) need
 * a workerd pool later.
 */

/**
 * Envelope-write storage. On workerd this wraps SQLite-backed DO storage used
 * WITHOUT `await` so output gates hold outgoing I/O until the write is
 * confirmed (proposal §3 — this is what makes RUNNING-FIRST literal). The port
 * is synchronous by contract; a fake records ordering.
 */
export interface StoragePort {
  put(key: string, value: unknown): void;
  get(key: string): unknown;
  delete(key: string): void;
}

/**
 * Host wiring for DO alarms: `set` schedules, the platform (or a fake) calls
 * back. On real Cloudflare, firing arrives through the DO class's own
 * `alarm()` lifecycle handler — the host calls `KernelHandle#reconcile()`
 * from there directly, no port round-trip needed. `onFire` is an OPTIONAL
 * self-registration hook `installKernel` uses when the port offers it (the
 * matrix's fake host wires itself this way); real `AlarmPort` implementations
 * need not provide it.
 */
export interface AlarmPort {
  set(atEpochMs: number): void;
  onFire?(cb: () => void): void;
}

/** `ctx.waitUntil` — spawn/channel promise retention (proposal §5, finding G2). */
export type WaitUntilPort = (promise: Promise<unknown>) => void;

/** Session-hub awareness client mint — one per spawn, hub-unique id (proposal §8). */
export interface PresenceHubPort {
  mintClient(): { readonly clientID: number; setReport(frame: unknown): void; destroy(): void };
}

/**
 * The declare port (proposal §7, findings G15/G16): an in-process actor
 * REQUESTS a child; the HOST authors the mint transactionally; the kernel
 * activates it. Actors never hold a durable pen. Fire-and-forget: the returned
 * uuid identifies the child the actor may then OBSERVE as a doc peer.
 */
export interface DeclarePort {
  declare(kind: string, fields: Record<string, unknown>): string;
}

/**
 * FILLED CONTRACT GAP (declare port, proposal §7 G15/G16): neither the design
 * doc nor the proposal specifies how a bare `kind` STRING resolves to the
 * Expectation SUBCLASS to construct. `Orchestration.plans` (`InstallOpts#launchers`)
 * maps kind → LaunchDefinition (config), never an Expectation constructor —
 * design.md §3 binds triads BY CLASS, and the string kind exists only as a CRDT
 * map key. A host that wants ANY of its in-process actors to declare children
 * must therefore also register, per kind, the zero-arg factory that builds a
 * fresh (unmaterialized) instance of that kind's Expectation subclass — this is
 * that registry. Keyed identically to `launchers`'s `plans` map. Mirrors the
 * pattern of `DurableObjectLoader`'s own filled gap (`ctx.input` must carry the
 * uuid) — a silence the proposal left for the host layer to fill, not the core.
 */
export type ChildFactoryRegistry = ReadonlyMap<string, () => Expectation>;

/**
 * The expected structural shape of the SESSION doc's PEW root
 * (`InstallOpts#root`) — the host's declared work-roots list (design.md §11).
 * `InstallOpts#root` stays loosely typed (`unknown`) until the first product
 * consumer freezes its concrete doc-root class; this package only requires
 * the `openWork` list, cast at the boundary.
 */
export interface SessionRootLike {
  readonly openWork: Expectation[];
}

/**
 * The expected structural shape of the KERNEL doc's launcher home
 * (`InstallOpts#launchers`) — the durable LaunchDefinition registry (proposal
 * §1 two-doc topology). In practice this is a `@here.build/plexus-expectation`
 * `Orchestration` instance (its `plans` map already matches this shape);
 * `InstallOpts#launchers` stays `unknown` until the first consumer freezes it.
 */
export interface LauncherRootLike {
  readonly plans: Map<string, LaunchDefinition>;
}

export interface InstallOpts {
  /**
   * The SESSION doc's PEW root (Orchestration home) — the Expectation tree lives here.
   * Typed loosely until the first consumer freezes it.
   */
  readonly root: unknown;
  /**
   * The KERNEL doc's launcher home — the durable LaunchDefinition registry, shared across
   * sessions. A separate doc from the session doc (proposal §1 two-doc topology); definitions
   * reach declarations as snapshots, never as cross-doc entity refs. Typed loosely until the
   * first consumer freezes it.
   */
  readonly launchers: unknown;
  readonly storage: StoragePort;
  readonly alarms: AlarmPort;
  readonly waitUntil: WaitUntilPort;
  readonly presence: PresenceHubPort;
  /** Loader registry, keyed by LaunchDefinition class (contract §9). */
  readonly loaders: ReadonlyMap<abstract new (...args: never[]) => unknown, unknown>;
  /**
   * Declare-port kind → Expectation factory registry (proposal §7 G15/G16).
   * Optional: only hosts that register an {@link InProcessLoader}-based loader
   * need it — declare requests against an unregistered kind throw at mint time.
   * See {@link ChildFactoryRegistry}'s doc comment for why this registry exists.
   */
  readonly childFactories?: ChildFactoryRegistry;
  readonly log?: { append(line: string): void };
}

export interface KernelHandle {
  /** Orderly-shutdown dispose fold (proposal §1, finding G6): one fold pass over held work, then release. */
  dispose(): Promise<void>;
  /** Reconcile entry — alarm callback, wake hook, and doc reactions all funnel here (proposal §9). */
  reconcile(): void;
}
