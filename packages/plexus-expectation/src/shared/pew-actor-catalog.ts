/**
 * Session-hub execution face: author pens + actor report pens + reactive scans.
 * One instance per session awareness hub (via PEW).
 *
 * Per-expectation lanes on the author pen:
 *   `expectation:${uuid}:intents`       → {@link IntentLaneEntry}[]
 *   `expectation:${uuid}:cancellation`  → {@link CancellationLaneEntry}[]
 * No flat bag, no kernel routing table.
 */

import { PlexusAwareness } from "@here.build/plexus";

import {
  cancellationLaneField,
  intentLaneField,
  type CancellationLaneEntry,
  type IntentLaneEntry,
  type IntentRecord,
} from "./control.js";
import { isTerminal } from "./lifecycle.js";
import type { Expectation } from "./models/Expectation.js";
import { mintLocalNonZero, type ActorPresenceClient, type PEW } from "./presence.js";

const LANE_PREFIX = "expectation:";
const INTENTS_SUFFIX = ":intents";
const CANCEL_SUFFIX = ":cancellation";

type AuthoredLanes = {
  target: Expectation;
  intents: IntentLaneEntry[];
  cancellations: CancellationLaneEntry[];
};

export class PEWActorCatalog {
  #authorClient: PlexusAwareness | null = null;
  /** Author-side truth per target uuid — projected onto intent + cancel lanes. */
  readonly #authored = new Map<string, AuthoredLanes>();
  #requestSeq = 0;

  constructor(
    readonly pew: PEW,
    readonly awareness: PlexusAwareness,
  ) {}

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

  /**
   * Append one steer to `expectation:${uuid}:intents`. Returns the minted id.
   * Used by {@link PEW.request}.
   */
  appendIntent(target: Expectation, body: unknown): string {
    const client = this.#ensureAuthorClient();
    this.#pruneTerminalLanes(client);
    const intentId = this.#nextIntentId(client);
    const uuid = target.uuid;
    const rec = this.#ensureAuthored(uuid, target);
    rec.intents = [...rec.intents, { intentId, body }];
    client.setField(intentLaneField(uuid) as never, rec.intents as never);
    return intentId;
  }

  /**
   * Append one cancel to `expectation:${uuid}:cancellation`. Returns the minted id.
   * Used by {@link PEW.requestCancellation}.
   */
  appendCancellation(target: Expectation, body: unknown): string {
    const client = this.#ensureAuthorClient();
    this.#pruneTerminalLanes(client);
    const intentId = this.#nextIntentId(client);
    const uuid = target.uuid;
    const rec = this.#ensureAuthored(uuid, target);
    rec.cancellations = [...rec.cancellations, { intentId, body }];
    client.setField(cancellationLaneField(uuid) as never, rec.cancellations as never);
    return intentId;
  }

  /**
   * Replace the standing intents lane for one target (retract = `[]`, reshape = new list).
   */
  setTargetIntents(target: Expectation, entries: readonly IntentLaneEntry[]): void {
    const client = this.#ensureAuthorClient();
    this.#pruneTerminalLanes(client);
    const uuid = target.uuid;
    const rec = this.#ensureAuthored(uuid, target);
    rec.intents = [...entries];
    if (rec.intents.length === 0) {
      client.clearField(intentLaneField(uuid) as never);
      this.#dropIfEmpty(uuid);
      return;
    }
    client.setField(intentLaneField(uuid) as never, rec.intents as never);
  }

  /**
   * Replace the standing cancellation lane for one target (retract = `[]`).
   */
  setTargetCancellations(target: Expectation, entries: readonly CancellationLaneEntry[]): void {
    const client = this.#ensureAuthorClient();
    this.#pruneTerminalLanes(client);
    const uuid = target.uuid;
    const rec = this.#ensureAuthored(uuid, target);
    rec.cancellations = [...entries];
    if (rec.cancellations.length === 0) {
      client.clearField(cancellationLaneField(uuid) as never);
      this.#dropIfEmpty(uuid);
      return;
    }
    client.setField(cancellationLaneField(uuid) as never, rec.cancellations as never);
  }

  #nextIntentId(client: PlexusAwareness): string {
    this.#requestSeq += 1;
    return `i${client.clientID}-${this.#requestSeq}`;
  }

  /** Reactive scan of this uuid's intents lane across all peers. */
  laneEntries(uuid: string): readonly IntentLaneEntry[] {
    return collectIntentLane(this.awareness, uuid);
  }

  /** Reactive scan of this uuid's cancellation lane across all peers. */
  cancellationEntries(uuid: string): readonly CancellationLaneEntry[] {
    return collectCancellationLane(this.awareness, uuid);
  }

  /**
   * All standing author steers + cancels on this hub (lane scan).
   * Product cancel admission pairs openWork with {@link collectCancellationLane}.
   */
  get intents(): readonly IntentRecord[] {
    return collectAllIntentRecords(this.awareness);
  }

  #ensureAuthored(uuid: string, target: Expectation): AuthoredLanes {
    let rec = this.#authored.get(uuid);
    if (rec === undefined) {
      rec = { target, intents: [], cancellations: [] };
      this.#authored.set(uuid, rec);
    } else {
      rec.target = target;
    }
    return rec;
  }

  #dropIfEmpty(uuid: string): void {
    const rec = this.#authored.get(uuid);
    if (rec === undefined) return;
    if (rec.intents.length === 0 && rec.cancellations.length === 0) {
      this.#authored.delete(uuid);
    }
  }

  #pruneTerminalLanes(client: PlexusAwareness): void {
    for (const [uuid, rec] of [...this.#authored]) {
      if (!isTerminal(rec.target.state)) continue;
      this.#authored.delete(uuid);
      client.clearField(intentLaneField(uuid) as never);
      client.clearField(cancellationLaneField(uuid) as never);
    }
  }

  #ensureAuthorClient(): PlexusAwareness {
    if (this.#authorClient) return this.#authorClient;
    this.#authorClient = mintLocalNonZero(this.awareness);
    return this.#authorClient;
  }
}

/** Reactive scan of one expectation's intents lane across all hub peers. */
export function collectIntentLane(hub: PlexusAwareness, uuid: string): IntentLaneEntry[] {
  return collectLane(hub, intentLaneField(uuid));
}

/** Reactive scan of one expectation's cancellation lane across all hub peers. */
export function collectCancellationLane(hub: PlexusAwareness, uuid: string): CancellationLaneEntry[] {
  return collectLane(hub, cancellationLaneField(uuid));
}

function collectLane(hub: PlexusAwareness, key: string): { intentId: string; body: unknown }[] {
  const out: { intentId: string; body: unknown }[] = [];
  const reactive = hub.reactive;
  for (const id of reactive.clientIds) {
    const raw = reactive.clients.get(id).field(key);
    if (!Array.isArray(raw) || raw.length === 0) continue;
    for (const item of raw) {
      const entry = asLaneEntry(item);
      if (entry !== null) out.push(entry);
    }
  }
  return out;
}

/**
 * Scan all peers for `expectation:*:intents` and `expectation:*:cancellation`.
 * Targets are uuid-only stand-ins for intentId-list tests.
 */
export function collectAllIntentRecords(hub: PlexusAwareness): IntentRecord[] {
  const out: IntentRecord[] = [];
  const reactive = hub.reactive;
  for (const id of reactive.clientIds) {
    const client = reactive.clients.get(id);
    for (const name of client.fields) {
      if (!name.startsWith(LANE_PREFIX)) continue;
      let kind: "cancel" | undefined;
      let uuid: string;
      if (name.endsWith(INTENTS_SUFFIX)) {
        uuid = name.slice(LANE_PREFIX.length, name.length - INTENTS_SUFFIX.length);
        kind = undefined;
      } else if (name.endsWith(CANCEL_SUFFIX)) {
        uuid = name.slice(LANE_PREFIX.length, name.length - CANCEL_SUFFIX.length);
        kind = "cancel";
      } else {
        continue;
      }
      if (uuid.length === 0) continue;
      const raw = client.field(name);
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        const entry = asLaneEntry(item);
        if (entry === null) continue;
        out.push({
          intentId: entry.intentId,
          target: { uuid } as Expectation,
          body: entry.body,
          ...(kind === "cancel" ? { kind: "cancel" as const } : {}),
        });
      }
    }
  }
  return out;
}

function asLaneEntry(item: unknown): { intentId: string; body: unknown } | null {
  if (item === null || typeof item !== "object") return null;
  const rec = item as { intentId?: unknown; body?: unknown };
  if (typeof rec.intentId !== "string") return null;
  return { intentId: rec.intentId, body: rec.body };
}
