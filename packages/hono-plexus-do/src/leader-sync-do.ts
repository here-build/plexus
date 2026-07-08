/**
 * PlexusLeaderSyncDO — live Yjs leader on Cloudflare Durable Objects.
 *
 * Architecture: one DO instance holds the authoritative Y.Doc(s), brokers
 * hibernatable WebSockets, persists hot state to DO storage on a write-driven
 * alarm, and optionally mirrors diffs into a content-blind archive follower.
 *
 * Products subclass with declarative fields (`lanes`, `persistPolicy`, …) and
 * optional hooks (`getSeedState`, `archiveFollower`, `spillPolicy`). Docs are
 * spawned by the base — lane descriptors carry wire + persist metadata only.
 *
 * Boot sequence (inside `blockConcurrencyWhile`):
 *   1. Rehydrate each lane from `persistKey` (origin `snapshot`)
 *   2. Else call `getSeedState(laneId)` → apply + persist (origin `genesis`)
 *   3. Reload `entityId` + follower horizon SV from storage
 *   4. Wire lane listeners + awareness (after replay — no origin races)
 *
 * Identity: CF does not expose `idFromName` to the DO interior on the leader
 * path — `entityId` is persisted under {@link ENTITY_ID_STORAGE_KEY} via
 * `seed()` or `recordEntityId()` (inhuman's first `?project=` WS).
 *
 * Transport: all WS I/O routes through ChunkedDOTransport (>1 MiB safe).
 * Persist: {@link PersistScheduler} arms alarms only on peer-origined edits —
 * presence alone never defeats hibernation.
 */

import { ChunkedDOTransport } from "@here.build/chunked-websocket/server";
import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";

import { ENTITY_ID_STORAGE_KEY, GENESIS_ORIGIN, MESSAGE_SYNC } from "./constants.js";
import { UnknownLaneError, validateLaneDescriptors } from "./errors.js";
import { pushDiffToFollower, seedFollower } from "./follower.js";
import { encodeDocUpdate, encodeSyncStep1, handleYjsFrame, type ProtocolRouting } from "./protocol.js";
import { applyRehydrate, PersistScheduler, persistLaneSnapshot, shouldIgnoreUpdateOrigin } from "./persist.js";
import { spillDocToR2 } from "./spill.js";
import type {
  ArchiveFollowerStub,
  AwarenessPlane,
  LaneDescriptor,
  PersistPolicy,
  PlexusSyncEnv,
  PresenceProjector,
  ResolvedLane,
  SpillPolicy,
  WebSocketAttachment,
} from "./types.js";

export interface WebSocketHandshakeResult {
  attachment: WebSocketAttachment;
  responseHeaders?: HeadersInit;
}

export abstract class PlexusLeaderSyncDO<Env extends PlexusSyncEnv> extends DurableObject<Env> {
  // ── Declarative substrate ────────────────────────────────────────────────────

  /**
   * Wire + persist lanes. Override with a GETTER, never a field: a subclass field
   * initializer runs after `super()`, too late for the base constructor to read —
   * a getter lives on the prototype and resolves during construction. Docs are
   * spawned by the base — never pass `doc`.
   */
  protected get lanes(): readonly LaneDescriptor[] {
    return [{ id: "prime", messageType: MESSAGE_SYNC, persistKey: "yjs-state" }];
  }

  protected readonly persistPolicy: PersistPolicy = {
    debounceMs: 5_000,
    ceilingMs: 30_000,
  };

  /** DO storage key for the archive follower's last-known state vector. */
  protected readonly followerSvKey = "last-log-sv";

  protected awareness?: AwarenessPlane;
  protected presence?: PresenceProjector;

  // ── Runtime ──────────────────────────────────────────────────────────────────

  private readonly resolvedLanes: ResolvedLane[];
  private scheduler!: PersistScheduler;
  private lastKnownFollowerSv: Uint8Array = new Uint8Array();
  private transport!: ChunkedDOTransport;
  private _entityId: string | undefined;

  // ── Subclass contract ────────────────────────────────────────────────────────

  protected abstract authorizeWebSocket(request: Request): Promise<WebSocketHandshakeResult | null>;
  protected abstract handleHttp(request: Request): Promise<Response | null>;

  /** Read-only connections still receive every update and get syncStep1
   *  answered (catch-up works), but their inbound syncStep2/update frames are
   *  dropped before touching the doc. Default: nobody is read-only. */
  protected isReadOnlyConnection(_ws: WebSocket): boolean {
    return false;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Read the subclass lane config via the `lanes` getter (prototype-resolved
    // during super(); a subclass field would still be undefined here). Read once.
    const descriptors = this.lanes;
    validateLaneDescriptors(descriptors);
    this.resolvedLanes = this.spawnDocs(descriptors);
    this.initTransport();
    // eslint-disable-next-line sonarjs/no-async-constructor
    void ctx.blockConcurrencyWhile(async () => {
      await this.rehydrate();
      this.wireLaneListeners();
      this.wireAwareness();
      // Hibernation resume: re-handshake peers already accepted on this instance.
      for (const ws of ctx.getWebSockets()) {
        this.sendSyncStep1(ws);
      }
    });
  }

  /** Prime lane — `Plexus.connect(this.doc)` and Hono snapshot routes. */
  get doc(): Y.Doc {
    return this.primeLane.doc;
  }

  protected get primeLane(): ResolvedLane {
    return this.resolvedLanes[0]!;
  }

  /** Spawned doc for a sibling lane (e.g. `Plexus.connect(this.laneDoc("comments"))`). */
  protected laneDoc(id: string): Y.Doc {
    return this.lane(id).doc;
  }

  // ── Seed ─────────────────────────────────────────────────────────────────────

  /**
   * Genesis bytes when a lane's `persistKey` is empty on boot.
   * Default: null (prime stays empty until external `seed()`).
   * Non-prime lanes (comments) may bootstrap here.
   */
  protected async getSeedState(_laneId: string): Promise<Uint8Array | null> {
    return null;
  }

  protected async onLaneSeeded(_laneId: string): Promise<void> {}

  // ── Policy hooks ─────────────────────────────────────────────────────────────

  /** Inline R2 spill on leader alarm. Default none — archive DO owns cold duty. */
  protected spillPolicy(_entityId: string): SpillPolicy | null {
    return null;
  }

  protected archiveFollower(_entityId: string): ArchiveFollowerStub | null {
    return null;
  }

  protected isTestModeEnabled(): boolean {
    return Boolean(this.env.TEST_MODE);
  }

  protected onLaneUpdate(_laneId: string, _update: Uint8Array, _origin: unknown): void {}

  // ── RPC ──────────────────────────────────────────────────────────────────────

  async getSnapshot(laneId?: string): Promise<Uint8Array> {
    const lane = laneId ? this.lane(laneId) : this.primeLane;
    return Y.encodeStateAsUpdate(lane.doc);
  }

  async getStateVector(laneId?: string): Promise<Uint8Array> {
    const lane = laneId ? this.lane(laneId) : this.primeLane;
    return Y.encodeStateVector(lane.doc);
  }

  async getDiff(clientStateVector: Uint8Array, laneId?: string): Promise<Uint8Array> {
    const lane = laneId ? this.lane(laneId) : this.primeLane;
    return Y.diffUpdate(Y.encodeStateAsUpdate(lane.doc), clientStateVector);
  }

  /**
   * External first-touch (clone route). Persists entity id, applies prime bytes
   * with {@link GENESIS_ORIGIN}, optionally seeds archive follower before peers
   * connect. First-touch only — caller must not invoke on a non-empty prime doc.
   */
  async seed(entityId: string, yjsState: Uint8Array): Promise<void> {
    TypeError.invariant(yjsState.byteLength > 0, "PlexusLeaderSyncDO.seed: yjsState must not be empty");
    await this.recordEntityId(entityId);
    Y.applyUpdate(this.primeLane.doc, yjsState, GENESIS_ORIGIN);
    const merged = Y.encodeStateAsUpdate(this.primeLane.doc);
    await this.ctx.storage.put(this.primeLane.persistKey, merged);
    const follower = this.archiveFollower(entityId);
    if (follower) {
      this.lastKnownFollowerSv = await seedFollower(follower, merged);
      await this.ctx.storage.put(this.followerSvKey, this.lastKnownFollowerSv);
    }
    await this.onLaneSeeded(this.primeLane.id);
  }

  /**
   * Test/admin reset — clears storage and scheduler horizon. In-memory docs and
   * listeners remain; spawn a fresh DO instance for a full RAM reset.
   */
  async cleanup(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.scheduler = new PersistScheduler(this.persistPolicy, { testMode: this.isTestModeEnabled() });
    this.lastKnownFollowerSv = new Uint8Array();
    this._entityId = undefined;
  }

  // ── Cloudflare I/O ─────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }
    const http = await this.handleHttp(request);
    if (http) return http;
    return new Response("expected websocket upgrade", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    this.transport.onRawMessage(ws, message);
  }

  webSocketClose(ws: WebSocket): void {
    this.transport.detach(ws);
    const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
    const userId = attachment?.userId;
    const entityId = this.entityId();
    if (userId && entityId && this.presence) {
      this.presence.onSocketClose(String(userId), {
        entityId,
        env: this.env,
        storage: this.ctx.storage,
      });
    }
    this.onWebSocketClose(ws, attachment);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onWebSocketError(ws);
    this.webSocketClose(ws);
  }

  /**
   * Write-driven persist + optional follower push + optional R2 spill.
   * Follower push runs only when every pending lane persist succeeded — a failed
   * hot write must not advance the archive ahead of durable leader state.
   */
  async alarm(): Promise<void> {
    let pendingPersistFailed = false;

    for (const lane of this.resolvedLanes) {
      if (!this.scheduler.hasPendingWork(lane.id)) continue;
      const versionAtSnapshot = this.scheduler.versionAtSnapshot(lane.id);
      try {
        await persistLaneSnapshot(this.ctx.storage, lane, versionAtSnapshot, this.scheduler);
      } catch (error) {
        pendingPersistFailed = true;
        console.error(`[PlexusLeaderSyncDO] persist lane ${lane.id}:`, error);
      }
    }

    if (!pendingPersistFailed) {
      await this.pushToFollowerIfConfigured();
    }

    const entityId = this.entityId();
    const spill = entityId ? this.spillPolicy(entityId) : null;
    if (spill && entityId) {
      try {
        await spillDocToR2(this.primeLane.doc, entityId, spill);
      } catch (error) {
        console.error("[PlexusLeaderSyncDO] spill:", error);
      }
    }

    await this.onAlarm();

    if (this.scheduler.hasAnyPendingWork()) {
      this.schedulePersistAlarm();
    }
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  protected onWebSocketClose(_ws: WebSocket, _attachment: WebSocketAttachment | null): void {}

  protected onWebSocketError(_ws: WebSocket, _error?: unknown): void {}

  protected async onAlarm(): Promise<void> {}

  protected entityId(): string | undefined {
    return this._entityId;
  }

  protected async recordEntityId(entityId: string): Promise<void> {
    TypeError.invariant(entityId.length > 0, "recordEntityId: entityId must not be empty");
    this._entityId = entityId;
    await this.ctx.storage.put(ENTITY_ID_STORAGE_KEY, entityId);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  private spawnDocs(descriptors: readonly LaneDescriptor[]): ResolvedLane[] {
    return descriptors.map((descriptor) => ({
      ...descriptor,
      doc: new Y.Doc({ gc: descriptor.gc ?? true }),
    }));
  }

  private initTransport(): void {
    this.transport = new ChunkedDOTransport((ws, data) => {
      if (typeof data === "string") return;
      this.processYjsMessage(ws, new Uint8Array(data));
    });
    this.scheduler = new PersistScheduler(this.persistPolicy, { testMode: this.isTestModeEnabled() });
  }

  private lane(id: string): ResolvedLane {
    const lane = this.resolvedLanes.find((l) => l.id === id);
    UnknownLaneError.invariant(lane != null, id);
    return lane;
  }

  private routing(): ProtocolRouting {
    const [prime, ...rest] = this.resolvedLanes;
    return { prime: prime!, extraLanes: rest, awareness: this.awareness };
  }

  private async rehydrate(): Promise<void> {
    const [laneSnapshots, followerSv, storedEntityId] = await Promise.all([
      Promise.all(this.resolvedLanes.map((lane) => this.ctx.storage.get<Uint8Array>(lane.persistKey))),
      this.ctx.storage.get<Uint8Array>(this.followerSvKey),
      this.ctx.storage.get<string>(ENTITY_ID_STORAGE_KEY),
    ]);
    if (storedEntityId) this._entityId = storedEntityId;
    if (followerSv) this.lastKnownFollowerSv = followerSv;

    for (let i = 0; i < this.resolvedLanes.length; i++) {
      const lane = this.resolvedLanes[i]!;
      const bytes = laneSnapshots[i];
      if (bytes) {
        try {
          applyRehydrate(lane.doc, bytes);
        } catch (error) {
          // Never brick boot on a poisoned snapshot — start empty; peers resync from clients.
          console.error(
            `[PlexusLeaderSyncDO] corrupt snapshot for lane "${lane.id}" — starting empty, peers will resync:`,
            error,
          );
        }
        continue;
      }
      const seed = await this.getSeedState(lane.id);
      if (!seed || seed.byteLength === 0) continue;
      Y.applyUpdate(lane.doc, seed, GENESIS_ORIGIN);
      await this.ctx.storage.put(lane.persistKey, Y.encodeStateAsUpdate(lane.doc));
      await this.onLaneSeeded(lane.id);
    }
  }

  private wireLaneListeners(): void {
    for (const lane of this.resolvedLanes) {
      lane.doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (shouldIgnoreUpdateOrigin(origin)) return;
        this.scheduler.markDirty(lane.id);
        void this.schedulePersistAlarm();
        this.broadcastLaneUpdate(lane, update, origin);
        this.onLaneUpdate(lane.id, update, origin);
      });
    }
  }

  private wireAwareness(): void {
    if (!this.awareness) return;
    this.awareness.onChange((changes, origin) => {
      const frame = this.awareness!.encodeUpdate([...changes.added, ...changes.updated, ...changes.removed]);
      for (const ws of this.ctx.getWebSockets()) {
        if (ws === origin) continue;
        this.transport.send(ws, frame.buffer);
      }
      const entityId = this.entityId();
      if (entityId && this.presence && (changes.added.length || changes.updated.length)) {
        this.presence.onAwarenessDelta(changes, { entityId, env: this.env, storage: this.ctx.storage });
      }
    });
  }

  private broadcastLaneUpdate(lane: ResolvedLane, update: Uint8Array, origin: unknown): void {
    const encoded = encodeDocUpdate(update, lane.messageType);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === origin) continue;
      if (lane.broadcastFilter && !lane.broadcastFilter(ws)) continue;
      this.transport.send(ws, encoded.buffer);
    }
  }

  private processYjsMessage(ws: WebSocket, data: Uint8Array): void {
    try {
      const response = handleYjsFrame(data, this.routing(), ws, ws, {
        readOnly: this.isReadOnlyConnection(ws),
        allowMessageType: (messageType, socket) => {
          const lane = this.resolvedLanes.find((l) => l.messageType === messageType);
          if (!lane?.allowInbound) return true;
          return lane.allowInbound(socket);
        },
      });
      if (response) this.transport.send(ws, response.buffer);
    } catch (error) {
      console.error("[PlexusLeaderSyncDO] protocol decode failed:", error);
    }
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const handshake = await this.authorizeWebSocket(request);
    if (!handshake) return new Response("Unauthorized", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(handshake.attachment);
    // Prime lane only — sibling lanes (comments) sync when the client sends step1.
    this.sendSyncStep1(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: handshake.responseHeaders,
    });
  }

  private sendSyncStep1(ws: WebSocket): void {
    this.transport.send(ws, encodeSyncStep1(this.primeLane.doc, MESSAGE_SYNC).buffer);
  }

  /**
   * Advance (never delay) the persist alarm. `waitUntil` so the RPC/WS handler
   * returns before storage I/O; only moves alarm earlier when edits pin RPO.
   */
  private schedulePersistAlarm(): void {
    if (this.isTestModeEnabled()) return;
    this.ctx.waitUntil(
      (async () => {
        const existing = await this.ctx.storage.getAlarm();
        const target = this.scheduler.nextAlarmTarget(existing);
        if (target !== null && (existing === null || target < existing)) {
          await this.ctx.storage.setAlarm(target);
        }
      })(),
    );
  }

  private async pushToFollowerIfConfigured(): Promise<void> {
    const entityId = this.entityId();
    if (!entityId) return;
    const follower = this.archiveFollower(entityId);
    if (!follower) return;
    try {
      this.lastKnownFollowerSv = await pushDiffToFollower(this.primeLane.doc, this.lastKnownFollowerSv, follower);
      await this.ctx.storage.put(this.followerSvKey, this.lastKnownFollowerSv);
    } catch (error) {
      console.error("[PlexusLeaderSyncDO] follower push failed:", error);
    }
  }
}
