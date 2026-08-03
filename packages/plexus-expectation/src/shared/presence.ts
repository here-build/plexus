/**
 * Presence lens over session + orchestration hubs.
 *
 * `new PEW({ kernel? })` — no attach API; hubs resolve via entity.__doc__ /
 * docPlexus / session.awareness. Claim owner mints an arbitrary client id
 * (never 0 — plexus-internal). Hub change → version boxes → computed plans/
 * claims; peer atoms isolate reportOf.
 */

import {
  type AwarenessSerializable,
  type AwarenessShape,
  docPlexus,
  Plexus,
  PlexusAwareness,
  PlexusModel,
  removeAwarenessStates,
} from "@here.build/plexus";
import {
  computed,
  createAtom,
  observable,
  runInAction,
  type IAtom,
  type IComputedValue,
  type IObservableValue,
} from "mobx";

import type { IntentAck, IntentAckState, IntentRecord } from "./control.js";
import type { Expectation } from "./models/Expectation.js";

const CHANNEL_STRIDE = 2 ** 51; // plexus multi-channel base packing
const baseOf = (raw: number): number => raw % CHANNEL_STRIDE;


export type LoaderCapability<TArgs = unknown> = {
  readonly status: "ready" | "blocked" | "unavailable";
  readonly door?: string;
  readonly args?: TArgs;
  readonly probedAt?: number;
};

export type LoaderHealth = "loading" | "loaded" | `failed:${string}`;

export type PlanAvailability = {
  readonly kind: string;
  readonly health: LoaderHealth | "unadvertised";
  readonly capability?: LoaderCapability;
  readonly source: "catalog" | "loader" | "both";
};

export type PewClaimRecord = {
  readonly clientId: number;
  readonly binds: readonly Expectation[];
  readonly acks: readonly IntentAck[];
};

export type ClaimPresenceStatus = {
  readonly binds: readonly Expectation[];
  readonly acks: readonly IntentAck[];
};

export type CatalogPresenceStatus = {
  readonly loaders: Readonly<Record<string, LoaderHealth>>;
  readonly capabilities: Readonly<Record<string, LoaderCapability>>;
};

/** @deprecated Prefer ClaimPresenceStatus + CatalogPresenceStatus. */
export type KernelPresenceStatus = {
  readonly binds: readonly Expectation[];
  readonly loaders: Readonly<Record<string, LoaderHealth>>;
  readonly capabilities: Readonly<Record<string, LoaderCapability>>;
  readonly acks: readonly IntentAck[];
};

export type PresencePort = {
  mintClient(): ActorPresenceClient;
};

export type ActorPresenceClient = {
  readonly clientID: number;
  setReport(frame: unknown): void;
  destroy(): void;
};

type PewHubShape = AwarenessShape & {
  role?: "kernel" | "catalog" | "loader";
  binds?: readonly Expectation[];
  loaders?: Readonly<Record<string, LoaderHealth>>;
  capabilities?: Readonly<Record<string, LoaderCapability>>;
  acks?: readonly IntentAck[];
  report?: AwarenessSerializable;
  intents?: readonly IntentRecord[];
  kind?: string;
  capability?: LoaderCapability;
};

type ChangePayload = { added: number[]; updated: number[]; removed: number[] };

type HubState = {
  readonly hub: PlexusAwareness<PewHubShape>;
  readonly catalogVersion: IObservableValue<number>;
  readonly claimVersion: IObservableValue<number>;
  readonly membership: IAtom;
  readonly peers: Map<number, IAtom>;
  readonly plans: IComputedValue<ReadonlyMap<string, PlanAvailability>>;
  readonly claims: IComputedValue<readonly PewClaimRecord[]>;
  readonly intents: IComputedValue<readonly IntentRecord[]>;
  readonly onChange: (changes: ChangePayload) => void;
  claimClient: PlexusAwareness<PewHubShape> | null;
  authorClient: PlexusAwareness<PewHubShape> | null;
  catalogClient: PlexusAwareness<PewHubShape> | null;
};


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlexus = Plexus<any>;

export type PEWOptions = {
  readonly kernel?: AnyPlexus | null;
};

export class PEW {
  readonly #kernel: AnyPlexus | null;
  readonly #hubs = new Map<PlexusAwareness, HubState>();
  #catalogClient: PlexusAwareness<PewHubShape> | null = null;

  constructor(opts: PEWOptions = {}) {
    this.#kernel = opts.kernel ?? null;
  }


  get plans(): ReadonlyMap<string, PlanAvailability> {
    const hub = this.#kernelHub();
    if (!hub) return new Map();
    return this.#state(hub).plans.get();
  }

  plan(kind: string): PlanAvailability | undefined {
    return this.plans.get(kind);
  }

  publishCatalog(status: CatalogPresenceStatus): void {
    const hub = this.#kernelHub();
    if (!hub) return;
    const client = this.#ensureCatalogClient(hub);
    client.setField("role", "catalog");
    client.setField("loaders", status.loaders as never);
    client.setField("capabilities", status.capabilities as never);
  }


  reportOf<TReport = unknown>(E: Expectation<unknown, TReport>): TReport | undefined {
    const cid = E.processorClientId;
    const hub = this.#hubForEntity(E);
    if (!hub) return undefined;
    const st = this.#state(hub);
    if (!isLegalPewClientId(cid)) {
      st.membership.reportObserved();
      return undefined;
    }
    this.#peerAtom(st, cid).reportObserved();
    return this.#readReport(hub, cid) as TReport | undefined;
  }

  isBound(E: Expectation): boolean {
    const hub = this.#hubForEntity(E);
    if (!hub) return false;
    const claims = this.#state(hub).claims.get();
    if (claims.length !== 1) return false;
    return claims[0]!.binds.some((b) => b.uuid === E.uuid);
  }

  claim(session: AnyPlexus): PewClaimRecord | null {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const found = this.#state(hub).claims.get();
    if (found.length !== 1) return null;
    return found[0]!;
  }

  hasDualClaim(session: AnyPlexus): boolean {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    return this.#state(hub).claims.get().length > 1;
  }

  ack(intentId: string, session: AnyPlexus): IntentAckState | undefined {
    const rec = this.claim(session);
    if (!rec) return undefined;
    return rec.acks.find((a) => a.intentId === intentId)?.state;
  }

  readIntents(session: AnyPlexus): readonly IntentRecord[] {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    return this.#state(hub).intents.get();
  }

  publishClaim(session: AnyPlexus, status: ClaimPresenceStatus): void {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const client = this.#ensureClaimClient(hub);
    client.setField("role", "kernel");
    // markers: secondary clients must not call referenceSymbol (doc mismatch)
    client.setField("binds", toEntityMarkers(status.binds) as never);
    client.setField("acks", status.acks as never);
  }

  installClaim(session: AnyPlexus): void {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const st = this.#state(hub);
    // lease-holder install: drop stale claim peers (dead predecessor or lease bug)
    const toRemove: number[] = [];
    for (const base of this.#allBases(hub)) {
      if (this.#rawRole(hub, base) === "kernel") toRemove.push(base);
    }
    if (toRemove.length > 0) {
      removeAwarenessStates(hub, toRemove, "pew-install-evict");
    }
    st.claimClient?.destroy();
    st.claimClient = null;
    this.#ensureClaimClient(hub);
  }

  /** Mint+publish new claim before destroying old — no observer-visible gap. */
  reloadClaim(session: AnyPlexus, status: ClaimPresenceStatus): void {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const st = this.#state(hub);
    const old = st.claimClient;
    st.claimClient = null;
    const next = this.#ensureClaimClient(hub);
    next.setField("role", "kernel");
    next.setField("binds", toEntityMarkers(status.binds) as never);
    next.setField("acks", status.acks as never);
    old?.destroy();
  }

  retireClaim(session: AnyPlexus): void {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const st = this.#hubs.get(hub);
    if (!st) return;
    st.claimClient?.destroy();
    st.claimClient = null;
  }

  mintActorClient(session: AnyPlexus): ActorPresenceClient {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const client = this.#mintBridged(hub);
    return {
      clientID: client.clientID,
      setReport: (frame: unknown) => {
        client.setField("report", frame as never);
      },
      destroy: () => client.destroy(),
    };
  }

  publishIntents(session: AnyPlexus, intents: readonly IntentRecord[]): void {
    const hub = session.awareness as PlexusAwareness<PewHubShape>;
    const client = this.#ensureAuthorClient(hub);
    const wire = intents.map((i) => ({
      intentId: i.intentId,
      target: { "\0": [i.target.uuid] },
      body: i.body,
    }));
    client.setField("intents", wire as never);
  }

  #kernelHub(): PlexusAwareness<PewHubShape> | null {
    if (!this.#kernel) return null;
    return this.#kernel.awareness as PlexusAwareness<PewHubShape>;
  }

  #hubForEntity(E: Expectation): PlexusAwareness<PewHubShape> | null {
    const doc = E.__doc__;
    if (!doc) return null;
    const plexus = docPlexus.get(doc);
    if (!plexus) return null;
    return plexus.awareness as PlexusAwareness<PewHubShape>;
  }

  #state(hub: PlexusAwareness): HubState {
    let st = this.#hubs.get(hub);
    if (st) return st;
    const typedHub = hub as PlexusAwareness<PewHubShape>;
    const peers = new Map<number, IAtom>();
    const catalogVersion = observable.box(0);
    const claimVersion = observable.box(0);
    const membership = createAtom("PEW.membership");

    const plans = computed(
      () => {
        catalogVersion.get();
        return this.#buildPlans(typedHub);
      },
      { name: "PEW.plans" },
    );
    const claims = computed(
      () => {
        claimVersion.get();
        return this.#scanClaims(typedHub);
      },
      { name: "PEW.claims" },
    );
    const intents = computed(
      () => {
        claimVersion.get();
        return this.#scanIntents(typedHub, () => this.#hubs.get(hub));
      },
      { name: "PEW.intents" },
    );

    const onChange = (changes: ChangePayload): void => {
      const bases = new Set<number>();
      for (const cid of [...changes.added, ...changes.updated, ...changes.removed]) {
        bases.add(baseOf(cid));
      }
      for (const base of bases) peers.get(base)?.reportChanged();
      if (changes.added.length || changes.removed.length) membership.reportChanged();
      let touchCatalog = changes.removed.length > 0;
      let touchClaim = changes.removed.length > 0;
      for (const base of bases) {
        const role = this.#rawRole(typedHub, base);
        if (role === "catalog" || role === "loader") touchCatalog = true;
        if (role === "kernel") touchClaim = true;
        const rec = this.#record(typedHub, base);
        if (rec?.intents) touchClaim = true;
        if (rec?.role === "kernel" || rec?.binds || rec?.acks || rec?.intents) touchClaim = true;
        if (rec?.role === "catalog" || rec?.loaders || rec?.capabilities) touchCatalog = true;
      }
      runInAction(() => {
        if (touchCatalog) catalogVersion.set(catalogVersion.get() + 1);
        if (touchClaim) claimVersion.set(claimVersion.get() + 1);
      });
    };
    hub.on("change", onChange as (...args: unknown[]) => void);
    let tearingDown = false;
    const destroyHub = (): void => {
      if (tearingDown) return;
      tearingDown = true;
      hub.off("change", onChange as (...args: unknown[]) => void);
      const cur = this.#hubs.get(hub);
      this.#hubs.delete(hub);
      // catalog may be the hub base — don't destroy it
      if (cur?.claimClient && cur.claimClient !== hub) cur.claimClient.destroy();
      if (cur?.authorClient && cur.authorClient !== hub) cur.authorClient.destroy();
      if (cur?.catalogClient && cur.catalogClient !== hub) cur.catalogClient.destroy();
    };
    hub.on("destroy", destroyHub as (...args: unknown[]) => void);
    st = {
      hub: typedHub,
      catalogVersion,
      claimVersion,
      membership,
      peers,
      plans,
      claims,
      intents,
      onChange,
      claimClient: null,
      authorClient: null,
      catalogClient: null,
    };
    this.#hubs.set(hub, st);
    return st;
  }

  #peerAtom(st: HubState, clientId: number): IAtom {
    let a = st.peers.get(clientId);
    if (!a) {
      a = createAtom(`PEW.peer:${clientId}`);
      st.peers.set(clientId, a);
    }
    return a;
  }

  #ensureCatalogClient(hub: PlexusAwareness<PewHubShape>): PlexusAwareness<PewHubShape> {
    const st = this.#state(hub);
    if (st.catalogClient) return st.catalogClient;
    if (this.#kernel && hub === this.#kernel.awareness) {
      st.catalogClient = hub;
      this.#catalogClient = hub;
      return hub;
    }
    st.catalogClient = this.#mintBridged(hub);
    return st.catalogClient;
  }

  #ensureClaimClient(hub: PlexusAwareness<PewHubShape>): PlexusAwareness<PewHubShape> {
    const st = this.#state(hub);
    if (st.claimClient) return st.claimClient;
    st.claimClient = this.#mintBridged(hub);
    return st.claimClient;
  }

  #ensureAuthorClient(hub: PlexusAwareness<PewHubShape>): PlexusAwareness<PewHubShape> {
    const st = this.#state(hub);
    if (st.authorClient) return st.authorClient;
    st.authorClient = this.#mintBridged(hub);
    return st.authorClient;
  }

  /**
   * Secondaries share hub.states but emit change on themselves — forward to
   * the hub onChange so computeds/peer atoms see claim/actor/author writes.
   */
  #mintBridged(hub: PlexusAwareness<PewHubShape>): PlexusAwareness<PewHubShape> {
    const st = this.#state(hub);
    const client = mintLocalNonZero(hub);
    const onChange = st.onChange as (...args: unknown[]) => void;
    client.on("change", onChange);
    const origDestroy = client.destroy.bind(client);
    Object.defineProperty(client, "destroy", {
      configurable: true,
      value: () => {
        client.off("change", onChange);
        origDestroy();
      },
    });
    return client;
  }

  #allBases(hub: PlexusAwareness): number[] {
    const bases = new Set<number>([hub.clientID, ...hub.getPeerIds()]);
    for (const cid of hub.states.keys()) {
      if (baseOf(cid) === cid) bases.add(cid);
    }
    return [...bases];
  }

  #record(hub: PlexusAwareness<PewHubShape>, base: number): Partial<PewHubShape> | null {
    if (base === hub.clientID) return hub.getLocalState();
    return hub.getPeer(base);
  }

  #rawRole(hub: PlexusAwareness<PewHubShape>, base: number): string | undefined {
    try {
      const raw = hub.getRawPeer(base) ?? (base === hub.clientID ? hub.getRawLocalState() : null);
      const role = raw?.role;
      return typeof role === "string" ? role : undefined;
    } catch {
      return undefined;
    }
  }

  #readReport(hub: PlexusAwareness<PewHubShape>, clientId: number): unknown | undefined {
    try {
      const rec = this.#record(hub, clientId);
      if (!rec || !("report" in rec)) return undefined;
      return rec.report;
    } catch {
      return undefined;
    }
  }

  #scanClaims(hub: PlexusAwareness<PewHubShape>): PewClaimRecord[] {
    const out: PewClaimRecord[] = [];
    for (const base of this.#allBases(hub)) {
      if (this.#rawRole(hub, base) !== "kernel") continue;
      let rec: Partial<PewHubShape> | null = null;
      try {
        rec = this.#record(hub, base);
      } catch {
        continue;
      }
      out.push({
        clientId: base,
        binds: normalizeBinds(rec?.binds),
        acks: (rec?.acks ?? []) as readonly IntentAck[],
      });
    }
    return out;
  }

  #scanIntents(
    hub: PlexusAwareness<PewHubShape>,
    hubState: () => HubState | undefined,
  ): readonly IntentRecord[] {
    const out: IntentRecord[] = [];
    const own = new Set<number>();
    const st = hubState();
    if (st?.claimClient) own.add(st.claimClient.clientID);
    if (st?.authorClient) own.add(st.authorClient.clientID);
    for (const base of this.#allBases(hub)) {
      if (own.has(base)) continue;
      let rec: Partial<PewHubShape> | null = null;
      try {
        rec = this.#record(hub, base);
      } catch {
        continue;
      }
      const list = rec?.intents;
      if (!list?.length) continue;
      for (const intent of list) {
        const target = tryResolveEntity(intent.target);
        if (target) out.push({ intentId: intent.intentId, target, body: intent.body });
      }
    }
    return out;
  }

  #buildPlans(hub: PlexusAwareness<PewHubShape>): Map<string, PlanAvailability> {
    const map = new Map<string, PlanAvailability>();
    let catalog: Partial<PewHubShape> | null = null;
    for (const base of this.#allBases(hub)) {
      if (this.#rawRole(hub, base) !== "catalog") continue;
      try {
        catalog = this.#record(hub, base);
      } catch {
        catalog = null;
      }
      break;
    }
    const loaders = (catalog?.loaders ?? {}) as Readonly<Record<string, LoaderHealth>>;
    const capabilities = (catalog?.capabilities ?? {}) as Readonly<Record<string, LoaderCapability>>;
    for (const kind of new Set([...Object.keys(loaders), ...Object.keys(capabilities)])) {
      map.set(kind, {
        kind,
        health: loaders[kind] ?? "unadvertised",
        capability: capabilities[kind],
        source: "catalog",
      });
    }
    for (const base of this.#allBases(hub)) {
      if (this.#rawRole(hub, base) !== "loader") continue;
      let rec: Partial<PewHubShape> | null = null;
      try {
        rec = this.#record(hub, base);
      } catch {
        continue;
      }
      if (typeof rec?.kind !== "string") continue;
      const kind = rec.kind;
      const selfCap = rec.capability as LoaderCapability | undefined;
      const existing = map.get(kind);
      if (existing) {
        map.set(kind, {
          kind,
          health: existing.health,
          capability: selfCap ?? existing.capability,
          source: selfCap !== undefined ? (existing.source === "catalog" ? "both" : "loader") : existing.source,
        });
      } else if (selfCap !== undefined) {
        map.set(kind, { kind, health: "unadvertised", capability: selfCap, source: "loader" });
      }
    }
    return map;
  }
}


function isLegalPewClientId(cid: number): boolean {
  return typeof cid === "number" && cid !== 0 && Number.isFinite(cid);
}

function mintLocalNonZero(hub: PlexusAwareness): PlexusAwareness {
  for (let i = 0; i < 8; i++) {
    const client = PlexusAwareness.createLocalClient(hub);
    if (client.clientID !== 0) return client;
    client.destroy();
  }
  throw new Error("PEW: failed to mint non-zero awareness clientId");
}

function toEntityMarkers(binds: readonly Expectation[]): { "\0": [string] }[] {
  return binds.map((e) => ({ "\0": [e.uuid] as [string] }));
}

function normalizeBinds(raw: unknown): readonly Expectation[] {
  if (!Array.isArray(raw)) return [];
  const out: Expectation[] = [];
  for (const item of raw) {
    const e = tryResolveEntity(item);
    if (e) out.push(e);
  }
  return out;
}

function tryResolveEntity(value: unknown): Expectation | null {
  if (value == null) return null;
  try {
    if (value instanceof PlexusModel) return value as Expectation;
    if (typeof value === "object" && value !== null && "uuid" in value) {
      const u = (value as { uuid: unknown }).uuid;
      if (typeof u === "string") return value as Expectation;
    }
  } catch {
    return null;
  }
  return null;
}
