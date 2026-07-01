import * as Y from "yjs";

import { MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "../constants.js";
import type { ArchiveFollowerStub, LaneDescriptor, PlexusSyncEnv } from "../types.js";
import { PlexusLeaderSyncDO } from "../leader-sync-do.js";

export interface ToyEnv extends PlexusSyncEnv {
  TEST_MODE?: boolean;
}

export class RecordingFollowerStub implements ArchiveFollowerStub {
  readonly seeds: Uint8Array[] = [];
  readonly diffs: Uint8Array[] = [];

  async seed(initialState: Uint8Array): Promise<Uint8Array> {
    this.seeds.push(initialState);
    return new Uint8Array();
  }

  applyDiff(diff: Uint8Array): Uint8Array {
    this.diffs.push(diff);
    return new Uint8Array([1]);
  }
}

/** Minimal concrete leader for integration tests. */
export class ToyLeaderDO extends PlexusLeaderSyncDO<ToyEnv> {
  readonly laneUpdateOrigins: unknown[] = [];
  readonly follower = new RecordingFollowerStub();

  protected override archiveFollower(): ArchiveFollowerStub {
    return this.follower;
  }

  protected override onLaneUpdate(_laneId: string, _update: Uint8Array, origin: unknown): void {
    this.laneUpdateOrigins.push(origin);
  }

  protected override async authorizeWebSocket(): Promise<null> {
    return null;
  }

  protected override async handleHttp(): Promise<null> {
    return null;
  }

  /** Test-only bridge to the protected first-touch id recorder. */
  async recordEntityIdForTest(entityId: string): Promise<void> {
    await this.recordEntityId(entityId);
  }
}

/**
 * Overrides `lanes` (via getter) to add a sibling comments lane — guards the
 * subclass-config-during-super() contract: a field initializer would run too
 * late for the base constructor to spawn the second doc.
 */
export class ToyMultiLaneDO extends PlexusLeaderSyncDO<ToyEnv> {
  protected override get lanes(): readonly LaneDescriptor[] {
    return [
      { id: "prime", messageType: MESSAGE_SYNC, persistKey: "yjs-state" },
      { id: "comments", messageType: MESSAGE_COMMENTS_SYNC, persistKey: "yjs-state-comments" },
    ];
  }

  protected override async authorizeWebSocket(): Promise<null> {
    return null;
  }

  protected override async handleHttp(): Promise<null> {
    return null;
  }

  /** Expose the sibling lane's spawned doc for assertions. */
  commentsDoc(): Y.Doc {
    return this.laneDoc("comments");
  }
}