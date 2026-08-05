/**
 * Session-hub execution face: claim / author pens + reactive scans.
 * One instance per session awareness hub (via PEW). Observation rides the
 * ambient `awareness.reactive` lens; models cross the wire through the
 * substrate serde — no hand-built markers, no raw casts on the read side
 * beyond the wire-shape assertion.
 */

import { PlexusAwareness, removeAwarenessStates } from "@here.build/plexus";
import { computed } from "mobx";

import type { IntentAckState, IntentRecord } from "./control.js";
import { isTerminal } from "./lifecycle.js";
import type { Expectation } from "./models/Expectation.js";
import {
  mintLocalNonZero,
  type ActorPresenceClient,
  type ClaimPresenceStatus,
  type PEW,
  type PewClaimRecord,
} from "./presence.js";

export class PEWActorCatalog {
  #claimClient: PlexusAwareness | null = null;
  #authorClient: PlexusAwareness | null = null;
  /** Author-side truth for `pew.request*` — presence is its projection. */
  #authored: IntentRecord[] = [];
  #requestSeq = 0;

  constructor(
    readonly pew: PEW,
    readonly awareness: PlexusAwareness,
  ) {}

  @computed
  get claims(): readonly PewClaimRecord[] {
    const reactive = this.awareness.reactive;
    const out: PewClaimRecord[] = [];
    for (const id of reactive.clientIds) {
      const client = reactive.clients.get(id);
      if (client.field("role") !== "kernel") continue;
      const binds = client.field("binds");
      const acks = client.field("acks");
      out.push({
        clientId: id,
        binds: (Array.isArray(binds) ? binds : []) as readonly Expectation[],
        acks: (Array.isArray(acks) ? acks : []) as readonly PewClaimRecord["acks"][number][],
      });
    }
    return out;
  }

  /** Sole claim after scan; null if zero or dual. */
  @computed
  get claim(): PewClaimRecord | null {
    const found = this.claims;
    if (found.length !== 1) return null;
    return found[0]!;
  }

  @computed
  get hasDualClaim(): boolean {
    return this.claims.length > 1;
  }

  /** Author intents on the hub — excludes this catalog's own claim + author pens. */
  @computed
  get intents(): readonly IntentRecord[] {
    const reactive = this.awareness.reactive;
    const own = new Set<number>();
    if (this.#claimClient) own.add(this.#claimClient.clientID);
    if (this.#authorClient) own.add(this.#authorClient.clientID);
    const out: IntentRecord[] = [];
    for (const id of reactive.clientIds) {
      if (own.has(id)) continue;
      const list = reactive.clients.get(id).field("intents");
      if (!Array.isArray(list) || list.length === 0) continue;
      for (const intent of list as IntentRecord[]) {
        out.push({
          intentId: intent.intentId,
          target: intent.target,
          body: intent.body,
          ...(intent.kind === "cancel" ? { kind: "cancel" as const } : {}),
        });
      }
    }
    return out;
  }

  ack(intentId: string): IntentAckState | undefined {
    const rec = this.claim;
    if (!rec) return undefined;
    return rec.acks.find((a) => a.intentId === intentId)?.state;
  }

  /** Publish binds + acks on the stable claim client. */
  publishClaim(status: ClaimPresenceStatus): void {
    const client = this.#ensureClaimClient();
    client.setField("role", "kernel");
    client.setField("binds", status.binds as never);
    client.setField("acks", status.acks as never);
  }

  /**
   * Lease-holder install: evict stale claim peers, mint fresh claim client.
   * Call before first publish under a new lease.
   */
  installClaim(): void {
    const hub = this.awareness;
    const toRemove: number[] = [];
    for (const base of allBases(hub)) {
      if (rawRole(hub, base) === "kernel") toRemove.push(base);
    }
    if (toRemove.length > 0) {
      removeAwarenessStates(hub, toRemove, "pew-install-evict");
    }
    this.#claimClient?.destroy();
    this.#claimClient = null;
    // §17.5 install step 3: the role marker publishes NOW — a minted-but-silent
    // pen would leave a claim gap until the first publishClaim, firing runner
    // self-termination on observers that just saw the eviction.
    this.#ensureClaimClient().setField("role", "kernel");
  }

  /** Mint+publish new claim before destroying old — no observer-visible gap. */
  reloadClaim(status: ClaimPresenceStatus): void {
    const old = this.#claimClient;
    this.#claimClient = null;
    const next = this.#ensureClaimClient();
    next.setField("role", "kernel");
    next.setField("binds", status.binds as never);
    next.setField("acks", status.acks as never);
    old?.destroy();
  }

  retireClaim(): void {
    this.#claimClient?.destroy();
    this.#claimClient = null;
  }

  mintActorClient(): ActorPresenceClient {
    const client = mintLocalNonZero(this.awareness);
    return {
      clientID: client.clientID,
      setReport: (frame: unknown) => {
        client.setField("report", frame as never);
      },
      destroy: () => client.destroy(),
    };
  }

  publishIntents(intents: readonly IntentRecord[]): void {
    const client = this.#ensureAuthorClient();
    client.setField("intents", intents as never);
  }

  /**
   * `pew.request*` entry: prune settled records, mint an id unique across
   * authors (pen clientID + local seq), append, republish. The prune IS the
   * retract — a record leaves presence once acked terminally
   * (considered/dropped) or once its target seals, and the kernel's
   * ack-ledger cleanup keys on that disappearance (§8).
   */
  submitRequest(target: Expectation, body: unknown, kind?: "cancel"): string {
    const client = this.#ensureAuthorClient();
    this.#authored = this.#authored.filter((record) => {
      if (isTerminal(record.target.state)) return false;
      const state = this.ack(record.intentId);
      return state !== "considered" && state !== "dropped";
    });
    this.#requestSeq += 1;
    const intentId = `i${client.clientID}-${this.#requestSeq}`;
    this.#authored.push({ intentId, target, body, ...(kind === "cancel" ? { kind } : {}) });
    client.setField("intents", this.#authored as never);
    return intentId;
  }

  #ensureClaimClient(): PlexusAwareness {
    if (this.#claimClient) return this.#claimClient;
    this.#claimClient = mintLocalNonZero(this.awareness);
    return this.#claimClient;
  }

  #ensureAuthorClient(): PlexusAwareness {
    if (this.#authorClient) return this.#authorClient;
    this.#authorClient = mintLocalNonZero(this.awareness);
    return this.#authorClient;
  }
}

function allBases(hub: PlexusAwareness): number[] {
  const bases = new Set<number>([hub.clientID, ...hub.getPeerIds()]);
  for (const cid of hub.states.keys()) {
    if (cid < PlexusAwareness.CHANNEL_STRIDE) bases.add(cid);
  }
  return [...bases];
}

function rawRole(hub: PlexusAwareness, base: number): string | undefined {
  // Raw path — install eviction must not touch entity refs it is about to evict.
  const raw =
    (hub.getRawPeer(base) as { role?: unknown } | null) ??
    (base === hub.clientID ? (hub.getRawLocalState() as { role?: unknown } | null) : null);
  const role = raw?.role;
  return typeof role === "string" ? role : undefined;
}
