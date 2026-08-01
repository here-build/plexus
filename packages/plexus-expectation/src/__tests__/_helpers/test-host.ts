/**
 * Shared PEW runtime test host — production substrates only.
 *
 * - Forest on a real `Y.Doc` via `Plexus.bootstrap` (no sync server).
 * - Progress hub = `PlexusAwareness` on that doc; activate mints one client per E.
 * - Peer claim = remote peer still alive at `E.processorClientId`.
 */
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  Plexus,
  PlexusAwareness,
  type PlexusModel,
} from "@here.build/plexus";
import * as Y from "yjs";

import { Expectation, type AdjustmentBag } from "../../app/index.js";
import type { Orchestration } from "../../orchestration/index.js";
import { Orchestrator, type StartResolverFn } from "../../runtime/index.js";

/** Forest shape required by the host (any product TestForest). */
export type ForestLike = PlexusModel & {
  readonly orchestration: Orchestration;
  readonly openWork: readonly Expectation[];
};

export type PewTestHostOptions = {
  readonly modes?: ReadonlySet<string>;
  readonly maxRebinds?: number;
  /** Default true. */
  readonly claimOwner?: boolean;
  readonly walkCandidates?: () => Iterable<Expectation>;
  /** Optional open-adjustment bag (product root). */
  readonly adjustmentBag?: AdjustmentBag;
  /**
   * Extra awareness used as a peer (second doc). When set, `syncPeerFrom()`
   * copies that peer into the host hub so `hasLiveClaimPeerBind` can see it.
   */
  readonly peerAwareness?: PlexusAwareness;
};

/**
 * Bootstrap a forest root onto an ephemeral doc (plexus-native test shape).
 */
export function bootstrapForest<F extends PlexusModel>(
  forest: F,
  doc: Y.Doc = new Y.Doc(),
): { forest: F; doc: Y.Doc; dispose: () => void } {
  Plexus.bootstrap(forest, undefined, doc);
  return {
    forest,
    doc,
    dispose: () => {
      doc.destroy();
    },
  };
}

/**
 * Claim-owner host over a doc-backed forest + awareness hub.
 */
export class PewTestHost extends Orchestrator {
  readonly doc: Y.Doc;
  readonly awareness: PlexusAwareness;
  readonly starters: Map<string, StartResolverFn>;
  readonly modes: ReadonlySet<string>;
  claimOwner: boolean;
  private readonly candidates: () => Iterable<Expectation>;
  private readonly peerAwareness: PlexusAwareness | undefined;
  private readonly ownsDoc: boolean;
  private readonly adjustmentBag: AdjustmentBag | null;

  constructor(
    readonly forest: ForestLike,
    starters: Record<string, StartResolverFn> = {},
    options: PewTestHostOptions & { doc?: Y.Doc; ownsDoc?: boolean } = {},
  ) {
    super({ maxRebinds: options.maxRebinds });
    this.starters = new Map(Object.entries(starters));
    this.modes = options.modes ?? new Set(["inprocess", "surface"]);
    this.claimOwner = options.claimOwner ?? true;
    this.candidates = options.walkCandidates ?? (() => []);
    this.peerAwareness = options.peerAwareness;
    this.adjustmentBag = options.adjustmentBag ?? null;
    let existingDoc: Y.Doc | null = null;
    try {
      existingDoc = forest.__doc__;
    } catch {
      existingDoc = null;
    }
    this.doc = options.doc ?? existingDoc ?? new Y.Doc();
    this.ownsDoc = options.ownsDoc ?? (options.doc === undefined && existingDoc === null);
    if (existingDoc === null) {
      Plexus.bootstrap(forest, undefined, this.doc);
    }
    this.awareness = new PlexusAwareness(this.doc);
    Expectation.bindProgressHub(this.awareness);
  }

  /** Tear down hub bind and owned doc. */
  dispose(): void {
    Expectation.bindProgressHub(null);
    if (this.ownsDoc) {
      this.doc.destroy();
    }
  }

  /**
   * After a peer process publishes on `peerAwareness`, pull into this host hub.
   */
  syncPeerFrom(peer: PlexusAwareness = this.peerAwareness!): void {
    if (!peer) throw new Error("syncPeerFrom: no peer awareness");
    const clients = [...peer.states.keys()];
    if (clients.length === 0) return;
    applyAwarenessUpdate(this.awareness, encodeAwarenessUpdate(peer, clients), "remote");
  }

  getOrchestration(): Orchestration {
    return this.forest.orchestration;
  }

  supportsLaunchMode(mode: string): boolean {
    return this.modes.has(mode);
  }

  resolveModule(kind: string, launchMode: string): StartResolverFn | undefined {
    return this.starters.get(kind) ?? this.starters.get(launchMode);
  }

  registerModule(key: string, start: StartResolverFn): void {
    this.starters.set(key, start);
  }

  isClaimOwner(): boolean {
    return this.claimOwner;
  }

  getOpenWorkRoots(): readonly Expectation[] {
    return this.forest.openWork;
  }

  override getAdjustmentBag(): AdjustmentBag | null {
    return this.adjustmentBag;
  }

  walkCandidates(): Iterable<Expectation> {
    return this.candidates();
  }

  /**
   * Peer claim: durable pointer + remote presence still alive.
   * Local live client for E is *our* claim, not a peer bind.
   */
  hasLiveClaimPeerBind(E: Expectation): boolean {
    if (Expectation.hasLocalLivePresence(E)) return false;
    const cid = E.processorClientId;
    if (cid === 0) return false;
    return this.awareness.getPeer(cid) != null;
  }

  snapshotProductFields(E: Expectation): unknown {
    const rec = E as Expectation & { payload?: unknown };
    return rec.payload !== undefined ? { payload: rec.payload } : {};
  }

  /**
   * Claim advertisement is {@link Expectation.processorClientId} + live clients.
   * Kept for orchestrator hooks; no separate binds list.
   */
  publishAwarenessBinds(): void {
    // intentional no-op — processorClientId + createLocalClient are the ad
  }

  /** Test seam — protected bind map. */
  dropBind(E: Expectation): void {
    this.releaseLocalBind(E);
  }

  /** Test seam — install a local bind without activate. */
  installBind(
    E: Expectation,
    entry: { handle: { abort(reason?: unknown): void; readonly aborted: boolean }; epoch: number },
  ): void {
    this.setBind(E, entry);
  }
}
