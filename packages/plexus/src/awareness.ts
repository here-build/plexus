/**
 * Plexus Awareness — multi-channel presence protocol.
 *
 * Forked from y-protocols/awareness. Same wire format, compatible with
 * existing providers (y-websocket, y-webrtc, etc.).
 *
 * Key difference: one user occupies MULTIPLE clientIds in the awareness map.
 * Channel 0 (base clientId) carries the schema — an ordered list of field names.
 * Channel N carries the value for field N. Each channel has its own clock and
 * updates independently.
 *
 * Only channel 0 heartbeats. Field channels sleep until their value changes.
 * When channel 0 times out, all channels for that user are cleaned up.
 *
 * Wire format (unchanged from y-protocols):
 *   varUint(numClients) + repeated { varUint(clientID) varUint(clock) varString(JSON(state)) }
 *
 * Channel clientId derivation:
 *   channel 0: baseClientId                        (schema + heartbeat)
 *   channel N: baseClientId + N * 2^51              (field value)
 *
 * Base clientIds must stay in the regular range [0, 2^51) so channel packing
 * does not collide with liminal/committed/genesis namespaces.
 *
 * Multiple local identities per doc:
 *   new PlexusAwareness(doc)                              // base = doc.clientID
 *   new PlexusAwareness(doc, { clientId })                 // isolated maps, custom base
 *   new PlexusAwareness(doc, { clientId, hub: primary })   // share states/meta with hub
 *
 * Hub sharing is what makes multi-client-per-doc useful on the wire: secondaries
 * write into the hub map; network encode of hub.states sees every local base.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as f from "lib0/function";
import * as math from "lib0/math";
import * as time from "lib0/time";
import invariant from "tiny-invariant";
import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { deserialize, hasUnsatisfiableRefs, REF_JSON_ESCAPE, serialize } from "./awareness-serde.js";
import { isRegularClientId, newClientId } from "./genesis-client.js";
import type { AwarenessShape } from "./proxy-runtime-types.js";
import { bucketCount, telemetry } from "./telemetry.js";

/**
 * Multi-channel packing stride.
 *
 * One user occupies many keys in the awareness states map: channel 0 is the
 * schema (field-name list + heartbeat); channel N holds field N's value.
 * Keys are `base + channel * AWARENESS_CHANNEL_STRIDE` so field updates do not
 * collide with other bases' channel-0 heartbeats (y-protocols wire is flat).
 */
export const AWARENESS_CHANNEL_STRIDE = 2 ** 51;
export const outdatedTimeout = 30_000;

export const awarenessChannelId = (base: number, channel: number): number => base + channel * AWARENESS_CHANNEL_STRIDE;

export const parseAwarenessChannelId = (raw: number): { base: number; channel: number } => ({
  base: raw % AWARENESS_CHANNEL_STRIDE,
  channel: Math.floor(raw / AWARENESS_CHANNEL_STRIDE),
});

const channelId = awarenessChannelId;
const parseChannelId = parseAwarenessChannelId;

/** Options for {@link PlexusAwareness} construction. */
export type PlexusAwarenessOptions = {
  /**
   * Base awareness clientId for this identity. Defaults to `doc.clientID`.
   * Must be a regular-range id (`[0, 2^51)`). When omitted with `hub`, a fresh
   * id is minted via {@link newClientId}.
   */
  clientId?: number;
  /**
   * Share `states` / `meta` with this hub on the same doc. Required for multiple
   * local bases to appear on one encode/apply map (one Expectation = one client).
   */
  hub?: PlexusAwareness;
};

function resolveOptions(clientIdOrOptions?: number | PlexusAwarenessOptions): PlexusAwarenessOptions {
  if (clientIdOrOptions === undefined) return {};
  if (typeof clientIdOrOptions === "number") return { clientId: clientIdOrOptions };
  return clientIdOrOptions;
}

export class PlexusAwareness<Shape extends AwarenessShape = AwarenessShape> extends Awareness {
  static readonly CHANNEL_STRIDE = AWARENESS_CHANNEL_STRIDE;
  static readonly channelId = awarenessChannelId;
  static readonly parseChannelId = parseAwarenessChannelId;

  /** Ordered field names — also the channel-0 wire payload for this base. */
  private readonly _schema: string[] = [];

  /** Field name → 1-based channel index. */
  private readonly _fieldIndex = new Map<string, number>();

  /**
   * When this instance is a secondary (`createLocalClient`), writes land in the shared
   * hub map but `emit` would only fire on the secondary — wire listeners on the hub would
   * miss claim/actor/author frames. Re-emit `update` on the hub.
   */
  private readonly _hub: PlexusAwareness | null = null;

  /**
   * @param doc - Yjs document (wire identity for entity serde; not necessarily clientId source)
   * @param clientIdOrOptions - optional base clientId, or `{ clientId?, hub? }`
   */
  constructor(doc: Y.Doc, clientIdOrOptions?: number | PlexusAwarenessOptions) {
    super(doc);

    // parent Awareness starts its own heartbeat + writes setLocalState({}) for doc.clientID
    clearInterval(this._checkInterval);

    const opts = resolveOptions(clientIdOrOptions);

    if (opts.hub) {
      invariant(opts.hub.doc === doc, "PlexusAwareness: hub must share the same Y.Doc");
      // Drop isolated maps from super(); write into the hub wire map.
      this.states = opts.hub.states;
      this.meta = opts.hub.meta;
      this._hub = opts.hub as PlexusAwareness;
    } else {
      // super() left a single-blob {} under doc.clientID — not multi-channel schema.
      this.states.delete(doc.clientID);
      this.meta.delete(doc.clientID);
    }

    const baseId = opts.clientId === undefined ? (opts.hub ? newClientId() : doc.clientID) : opts.clientId;

    invariant(isRegularClientId(baseId), `PlexusAwareness: clientId must be regular-range [0, 2^51); got ${baseId}`);
    invariant(baseId !== opts.hub?.clientID, "PlexusAwareness: clientId must differ from hub.clientID");

    this.clientID = baseId;

    // Initialize channel 0 with empty schema for THIS base only
    this._writeChannel(0, [], "local");

    // Heartbeat + stale cleanup (this base only for heartbeat; peers GC as usual)
    this._checkInterval = setInterval(
      () => {
        const now = time.getUnixTime();

        const myMeta = this.meta.get(this.clientID);
        if (myMeta && this.states.has(this.clientID) && outdatedTimeout / 2 <= now - myMeta.lastUpdated) {
          this._writeChannel(0, [...this._schema], "local");
        }

        const toRemove: number[] = [];
        for (const [cid, meta] of this.meta.entries()) {
          if (cid === this.clientID) continue;
          const { channel } = parseChannelId(cid);
          if (channel !== 0) continue;
          if (outdatedTimeout <= now - meta.lastUpdated && this.states.has(cid)) {
            toRemove.push(cid);
          }
        }
        if (toRemove.length > 0) {
          for (const base of toRemove) this._removePeer(base, "timeout");
        }
      },
      math.floor(outdatedTimeout / 10),
    );

    // Each instance removes only its base on destroy; doc.destroy tears down all.
    doc.on("destroy", () => this.destroy());
  }

  /**
   * Additional local identity on the same doc, sharing the hub wire map.
   * One Expectation = one client: mint a client per progressive invocation.
   */
  static createLocalClient<Shape extends AwarenessShape = AwarenessShape>(
    hub: PlexusAwareness<Shape>,
    clientId?: number,
  ): PlexusAwareness<Shape> {
    return new PlexusAwareness(hub.doc, {
      clientId: clientId ?? newClientId(),
      hub: hub as PlexusAwareness,
    });
  }

  override destroy(): void {
    disposeCoherenceGate(this);
    this.emit("destroy", [this]);
    // Remove only this base's channels (shared hub keeps peers + other locals).
    const removed = this._removeLocalChannels();
    if (removed.length > 0) {
      const payload = { added: [] as number[], updated: [] as number[], removed };
      this.emit("change", [payload, "local"]);
      this.emit("update", [payload, "local"]);
      // Secondaries must surface removals on the hub for plane wire listeners.
      this._hub?.emit("update", [payload, "local"]);
    }
    clearInterval(this._checkInterval);
    // Parent destroy calls setLocalState(null) then clearInterval again.
    // With multi-channel, setLocalState(null) clears field values for this base only
    // via our override — safe. Avoid Observable double-destroy issues by not
    // re-entering if already torn down: parent still clears its interval id (same).
    try {
      super.destroy();
    } catch {
      // y-protocols Observable may throw if already destroyed when doc fires twice
    }
  }
  /** Set a field value. Registers the field in the schema on first use.
   *  PlexusModel instances in the value are auto-serialized to reference markers. */
  setField<K extends string & keyof Shape>(field: K, value: Shape[K]): void {
    let idx = this._fieldIndex.get(field);
    if (idx === undefined) {
      // New field — append to schema
      idx = this._schema.length + 1; // 1-based channel index
      this._schema.push(field);
      this._fieldIndex.set(field, idx);
      // Update channel 0 (schema)
      this._writeChannel(0, [...this._schema], "local");
    }
    this._writeChannel(idx, serialize(value, this.doc), "local");
  }

  /** Clear a field value. The field stays in the schema (append-only). */
  clearField(field: string & keyof Shape): void {
    const idx = this._fieldIndex.get(field);
    if (idx === undefined) return;
    this._writeChannel(idx, null, "local");
  }

  /** Get a local field value. Entity reference markers are auto-deserialized to live PlexusModel instances. */
  getField<K extends string & keyof Shape>(field: K): Shape[K] | null | undefined {
    const idx = this._fieldIndex.get(field);
    if (idx === undefined) return undefined;
    const raw = this.states.get(channelId(this.clientID, idx));
    if (raw === undefined) return null; // cleared field → null (not undefined)
    if (raw === null) return null;
    return deserialize(raw, this.doc) as Shape[K];
  }

  /**
   * Merged local state with channel values left in their raw (un-deserialized)
   * wire form. Entity markers are NOT resolved. Use this when you need the
   * serialized shape (e.g. JSON dedup) without triggering entity proxies.
   */
  getRawLocalState(): Record<string, unknown> | null {
    if (!this.states.has(this.clientID)) return null;
    const result: Record<string, unknown> = {};
    for (const [name, idx] of this._fieldIndex) {
      const val = this.states.get(channelId(this.clientID, idx));
      if (val !== undefined && val !== null) result[name] = val;
    }
    return result;
  }

  /** Get all local field values as a plain object. Entity references are auto-deserialized. */
  override getLocalState(): Partial<Shape> | null {
    const raw = this.getRawLocalState();
    if (!raw) return null;
    const result: Record<string, any> = {};
    for (const [name, val] of Object.entries(raw)) result[name] = deserialize(val, this.doc);
    return result as Partial<Shape>;
  }

  /** Get the schema (field names in registration order). */
  getSchema(): readonly string[] {
    return this._schema;
  }

  /** Set all fields at once. Overrides y-protocols to use multi-channel protocol. */
  override setLocalState(state: Record<string, any> | null): void {
    if (state === null) {
      for (const field of this._schema) this.clearField(field as string & keyof Shape);
      return;
    }
    for (const [field, value] of Object.entries(state)) {
      this.setField(field as string & keyof Shape, value);
    }
  }

  /** Set a single field. Overrides y-protocols to use multi-channel protocol. */
  override setLocalStateField(field: string, value: any): void {
    this.setField(field as string & keyof Shape, value);
  }

  /** Return the raw states map. Overrides y-protocols. */
  override getStates(): Map<number, any> {
    return this.states;
  }

  /**
   * Merged remote-peer state with channel values left in their raw
   * (un-deserialized) wire form. Entity markers are NOT resolved.
   */
  getRawPeer(baseClientId: number): Record<string, unknown> | null {
    const schema = this.states.get(baseClientId) as string[] | undefined;
    if (!schema || !Array.isArray(schema)) return null;
    const result: Record<string, unknown> = {};
    for (const [i, element] of schema.entries()) {
      const val = this.states.get(channelId(baseClientId, i + 1));
      if (val !== undefined && val !== null) result[element] = val;
    }
    return result;
  }

  /** Get merged state for a remote peer. Entity references are auto-deserialized. */
  getPeer(baseClientId: number): Partial<Shape> | null {
    const raw = this.getRawPeer(baseClientId);
    if (!raw) return null;
    const result: Record<string, any> = {};
    for (const [name, val] of Object.entries(raw)) result[name] = deserialize(val, this.doc);
    return result as Partial<Shape>;
  }

  /** Get all peer base clientIds (excludes self). */
  getPeerIds(): number[] {
    return [...this.states.keys()]
      .map(parseChannelId)
      .filter(({ base, channel }) => channel === 0 && base !== this.clientID)
      .map(({ base }) => base);
  }

  /** Write to a specific channel (local). */
  private _writeChannel(channelIndex: number, state: any, origin: any): void {
    const cid = channelId(this.clientID, channelIndex);
    const currMeta = this.meta.get(cid);
    // Start at 1 (not 0) so the first write is accepted by remote peers.
    // The y-protocols original starts at 0, which means clock-0 entries are
    // silently dropped by receivers (0 < 0 = false). In the original this
    // is mitigated by the user making a state change before the first sync,
    // but for multi-channel awareness we can't assume that — new fields may
    // be registered at any time.
    const clock = currMeta === undefined ? 1 : currMeta.clock + 1;
    const prevState = this.states.get(cid);

    if (state === null || state === undefined) {
      this.states.delete(cid);
    } else {
      this.states.set(cid, state);
    }
    this.meta.set(cid, { clock, lastUpdated: time.getUnixTime() });

    const added: number[] = [];
    const updated: number[] = [];
    const filteredUpdated: number[] = [];
    const removed: number[] = [];

    if (state == null) {
      if (prevState != null) removed.push(cid);
    } else if (prevState == null) {
      added.push(cid);
    } else {
      updated.push(cid);
      if (!f.equalityDeep(prevState, state)) filteredUpdated.push(cid);
    }

    if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
      this.emit("change", [{ added, updated: filteredUpdated, removed }, origin]);
    }
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      const updatePayload = { added, updated, removed };
      this.emit("update", [updatePayload, origin]);
      // Multi-client: secondaries share hub.states but would only emit here — forward
      // update so a single hub listener (plane wire) sees every local base.
      this._hub?.emit("update", [updatePayload, origin]);
    }
  }

  /** Remove all channels for a remote peer. */
  private _removePeer(baseClientId: number, origin: any): void {
    dropParkedForBase(this, baseClientId);
    const schema = this.states.get(baseClientId) as string[] | undefined;
    const removed: number[] = [];

    // Remove channel 0
    if (this.states.has(baseClientId)) {
      this.states.delete(baseClientId);
      removed.push(baseClientId);
    }

    // Remove all field channels
    if (schema && Array.isArray(schema)) {
      for (let i = 0; i < schema.length; i++) {
        const cid = channelId(baseClientId, i + 1);
        if (this.states.has(cid)) {
          this.states.delete(cid);
          removed.push(cid);
        }
      }
    }

    if (removed.length > 0) {
      this.emit("change", [{ added: [], updated: [], removed }, origin]);
      this.emit("update", [{ added: [], updated: [], removed }, origin]);
    }
  }

  /** Remove all local channels. Returns removed clientIds. */
  private _removeLocalChannels(): number[] {
    const removed: number[] = [];
    // Channel 0
    if (this.states.has(this.clientID)) {
      this.states.delete(this.clientID);
      const meta = this.meta.get(this.clientID);
      this.meta.set(this.clientID, { clock: (meta?.clock ?? 0) + 1, lastUpdated: time.getUnixTime() });
      removed.push(this.clientID);
    }
    // Field channels
    for (let i = 0; i < this._schema.length; i++) {
      const cid = channelId(this.clientID, i + 1);
      if (this.states.has(cid)) {
        this.states.delete(cid);
        const meta = this.meta.get(cid);
        this.meta.set(cid, { clock: (meta?.clock ?? 0) + 1, lastUpdated: time.getUnixTime() });
        removed.push(cid);
      }
    }
    return removed;
  }
}

// ── Protocol functions (forked from y-protocols, wire-compatible) ───

/**
 * Encode awareness update for specific clients.
 * Wire format: varUint(len) + repeated { varUint(clientID) varUint(clock) varString(JSON(state)) }
 */
export const encodeAwarenessUpdate = (
  awareness: PlexusAwareness,
  clients: number[],
  states: Map<number, any> = awareness.states,
): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clients.length);
  for (const clientID of clients) {
    const state = states.get(clientID) || null;
    const meta = awareness.meta.get(clientID);
    encoding.writeVarUint(encoder, clientID);
    encoding.writeVarUint(encoder, meta?.clock ?? 0);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  const bytes = encoding.toUint8Array(encoder);
  if (telemetry.enabled) {
    // CRDT-cohort canonical signal: >4KB awareness frame almost always
    // means someone stuffed a Y.Doc snapshot into a presence field.
    // Histogram lets dashboards alert on tail growth without sampling.
    telemetry.histogram("plexus.awareness.update_bytes", bytes.byteLength, {
      direction: "encode",
      client_count: bucketCount(clients.length),
    });
  }
  return bytes;
};

// ── Coherence gate (read half of docs/awareness-coherence.md) ───
//
// A frame whose entity refs the local doc cannot resolve yet is parked, not
// applied: observers keep the peer's last coherent frame until the doc catches
// up, then the frame applies through the normal change path. Local writes are
// never gated — serialize's referenceSymbol is the write half of the promise.

type ParkedFrame = { clock: number; state: any; origin: any };

type CoherenceGate = {
  /** Newest incoherent frame per channel clientId (awareness is LWW). */
  frames: Map<number, ParkedFrame>;
  /** Doc "update" listener while anything is parked; detached when drained. */
  listener: (() => void) | null;
};

const coherenceGates = new WeakMap<PlexusAwareness, CoherenceGate>();

function parkFrame(awareness: PlexusAwareness, clientID: number, clock: number, state: unknown, origin: any): void {
  let gate = coherenceGates.get(awareness);
  if (!gate) {
    gate = { frames: new Map(), listener: null };
    coherenceGates.set(awareness, gate);
  }
  const prev = gate.frames.get(clientID);
  if (prev && prev.clock >= clock) return;
  gate.frames.set(clientID, { clock, state, origin });
  if (telemetry.enabled) telemetry.counter("plexus.awareness.coherence_parked");
  if (gate.listener === null) {
    gate.listener = () => releaseParkedFrames(awareness);
    awareness.doc.on("update", gate.listener);
  }
}

/** Drop parked frames superseded by an applied (or stale-skipped) entry. */
function dropParkedUpTo(awareness: PlexusAwareness, clientID: number, clock: number): void {
  const gate = coherenceGates.get(awareness);
  if (!gate) return;
  const parked = gate.frames.get(clientID);
  if (parked && parked.clock <= clock) {
    gate.frames.delete(clientID);
    detachIfDrained(awareness, gate);
  }
}

function dropParkedForBase(awareness: PlexusAwareness, base: number): void {
  const gate = coherenceGates.get(awareness);
  if (!gate) return;
  for (const cid of [...gate.frames.keys()]) {
    if (parseChannelId(cid).base === base) gate.frames.delete(cid);
  }
  detachIfDrained(awareness, gate);
}

function releaseParkedFrames(awareness: PlexusAwareness): void {
  const gate = coherenceGates.get(awareness);
  if (!gate || gate.frames.size === 0) return;
  for (const [clientID, frame] of [...gate.frames]) {
    if (hasUnsatisfiableRefs(frame.state, awareness.doc)) continue;
    gate.frames.delete(clientID);
    const buckets = emptyBuckets();
    applyDecodedEntry(awareness, clientID, frame.clock, frame.state, buckets, time.getUnixTime());
    emitBuckets(awareness, buckets, frame.origin);
    if (telemetry.enabled) telemetry.counter("plexus.awareness.coherence_released");
  }
  detachIfDrained(awareness, gate);
}

function detachIfDrained(awareness: PlexusAwareness, gate: CoherenceGate): void {
  if (gate.frames.size === 0 && gate.listener !== null) {
    awareness.doc.off("update", gate.listener);
    gate.listener = null;
  }
}

function disposeCoherenceGate(awareness: PlexusAwareness): void {
  const gate = coherenceGates.get(awareness);
  if (!gate) return;
  gate.frames.clear();
  detachIfDrained(awareness, gate);
  coherenceGates.delete(awareness);
}

type ApplyBuckets = { added: number[]; updated: number[]; filteredUpdated: number[]; removed: number[] };

const emptyBuckets = (): ApplyBuckets => ({ added: [], updated: [], filteredUpdated: [], removed: [] });

function emitBuckets(awareness: PlexusAwareness, b: ApplyBuckets, origin: any): void {
  if (b.added.length > 0 || b.filteredUpdated.length > 0 || b.removed.length > 0) {
    awareness.emit("change", [{ added: b.added, updated: b.filteredUpdated, removed: b.removed }, origin]);
  }
  if (b.added.length > 0 || b.updated.length > 0 || b.removed.length > 0) {
    awareness.emit("update", [{ added: b.added, updated: b.updated, removed: b.removed }, origin]);
  }
}

/** One decoded wire entry against states/meta — clock ordering + self-protection. */
function applyDecodedEntry(
  awareness: PlexusAwareness,
  clientID: number,
  clock: number,
  state: any,
  buckets: ApplyBuckets,
  timestamp: number,
): void {
  const clientMeta = awareness.meta.get(clientID);
  const prevState = awareness.states.get(clientID);
  const currClock = clientMeta === undefined ? 0 : clientMeta.clock;

  if (currClock < clock || (currClock === clock && state === null && awareness.states.has(clientID))) {
    if (state === null) {
      // Self-protection: refuse removal of any of our own channels
      const { base } = parseChannelId(clientID);
      if (base === awareness.clientID && awareness.states.has(clientID)) {
        clock++;
      } else {
        awareness.states.delete(clientID);
      }
    } else {
      awareness.states.set(clientID, state);
    }

    awareness.meta.set(clientID, { clock, lastUpdated: timestamp });

    if (clientMeta === undefined && state !== null) {
      buckets.added.push(clientID);
    } else if (clientMeta !== undefined && state === null) {
      buckets.removed.push(clientID);
    } else if (state !== null) {
      if (!f.equalityDeep(state, prevState)) {
        buckets.filteredUpdated.push(clientID);
      }
      buckets.updated.push(clientID);
    }
  }
}

/**
 * Apply a remote awareness update. Accepts entries with newer clocks.
 * Null state = client removed. Self-protection: refuses removal of own clientId.
 *
 * Coherence gate: entries whose entity refs the local doc cannot resolve yet
 * are parked and applied when the doc catches up (docs/awareness-coherence.md).
 */
export const applyAwarenessUpdate = (awareness: PlexusAwareness, update: Uint8Array, origin: any): void => {
  if (telemetry.enabled) {
    telemetry.histogram("plexus.awareness.update_bytes", update.byteLength, { direction: "apply" });
  }
  const decoder = decoding.createDecoder(update);
  const timestamp = time.getUnixTime();
  const buckets = emptyBuckets();
  const len = decoding.readVarUint(decoder);

  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const raw = decoding.readVarString(decoder);
    const state = JSON.parse(raw);

    if (state !== null && raw.includes(REF_JSON_ESCAPE) && hasUnsatisfiableRefs(state, awareness.doc)) {
      parkFrame(awareness, clientID, clock, state, origin);
      continue;
    }

    applyDecodedEntry(awareness, clientID, clock, state, buckets, timestamp);
    dropParkedUpTo(awareness, clientID, clock);
  }

  emitBuckets(awareness, buckets, origin);
};

/**
 * Remove awareness states for specific clients.
 * Used for explicit disconnection or server-side cleanup.
 */
export const removeAwarenessStates = (awareness: PlexusAwareness, clients: number[], origin: any): void => {
  const removed: number[] = [];
  for (const clientID of clients) {
    // Explicit removal supersedes any frame still waiting on the coherence gate.
    dropParkedForBase(awareness, parseChannelId(clientID).base);
    if (awareness.states.has(clientID)) {
      awareness.states.delete(clientID);
      if (parseChannelId(clientID).base === awareness.clientID) {
        const curMeta = awareness.meta.get(clientID);
        awareness.meta.set(clientID, { clock: (curMeta?.clock ?? 0) + 1, lastUpdated: time.getUnixTime() });
      }
      removed.push(clientID);
    }
  }
  if (removed.length > 0) {
    awareness.emit("change", [{ added: [], updated: [], removed }, origin]);
    awareness.emit("update", [{ added: [], updated: [], removed }, origin]);
  }
};

/**
 * Decode and re-encode an awareness update with a transform function.
 * Useful for server-side validation/sanitization.
 */
export const modifyAwarenessUpdate = (update: Uint8Array, modify: (state: any) => any): Uint8Array => {
  const decoder = decoding.createDecoder(update);
  const encoder = encoding.createEncoder();
  const len = decoding.readVarUint(decoder);
  encoding.writeVarUint(encoder, len);
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    encoding.writeVarUint(encoder, clientID);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(modify(state)));
  }
  return encoding.toUint8Array(encoder);
};
