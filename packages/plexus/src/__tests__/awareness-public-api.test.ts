import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { createTestPlexus, initTestPlexus } from "./test-plexus";

// Minimal awareness stub compatible enough for PlexusAwareness
class FakeAwareness {
  clientID = 1;
  private listeners = new Map<string, Set<() => void>>();
  private state = new Map<number, any>();

  setLocalStateField(key: string, value: any) {
    const current = this.state.get(this.clientID) || {};
    this.state.set(this.clientID, { ...current, [key]: value });
  }

  getStates(): Map<number, any> {
    return this.state;
  }

  on(evt: string, fn: () => void) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
  }

  off(evt: string, fn: () => void) {
    this.listeners.get(evt)?.delete(fn);
  }

  emit(evt: string) {
    this.listeners.get(evt)?.forEach((fn) => fn());
  }

  // Test helper to add a remote user state
  addRemote(clientId: number, plexusState: any) {
    this.state.set(clientId, { plexus: plexusState });
  }
}

@syncing
class Root extends PlexusModel {
  @syncing
  accessor name!: string;
}

describe("PlexusAwareness public API via Plexus", () => {
  it("updates local user state and broadcasts through awareness", async () => {
    const aw = new FakeAwareness();
    const rootEntity = new Root({ name: "root" });
    const { plexus } = await initTestPlexus<Root>(rootEntity, {}, aw as any);

    // Update various fields
    plexus.awareness.updateUserInfo({ name: "Alice", color: "#f00" });
    plexus.awareness.updateContext(["root", "node"]);
    plexus.awareness.updatePointer("entity-1", { x: 1, y: 2 });
    plexus.awareness.updateSelection(["entity-1"]);
    plexus.awareness.updateViewport({ bounds: { x: 0, y: 0, width: 100, height: 100 }, zoom: 2 });
    plexus.awareness.updateFollowing({ userId: "u2", mode: "cursor" });
    plexus.awareness.updateFocus(true);
    plexus.awareness.updateEditMode("typing", "text", { size: 12 });

    const local = aw.getStates().get(aw.clientID)!.plexus;
    expect(local.userInfo).toMatchObject({ name: "Alice", color: "#f00" });
    expect(local.currentContext).toEqual(["root", "node"]);
    expect(local.pointerPosition).toMatchObject({ entityId: "entity-1" });
    expect(local.selection).toEqual(["entity-1"]);
    expect(local.viewport.zoom).toBe(2);
    expect(local.following).toMatchObject({ userId: "u2", mode: "cursor" });
    expect(local.isFocused).toBe(true);
    expect(local.editMode).toBe("typing");
    expect(local.currentTool).toBe("text");
    expect(local.toolState).toMatchObject({ size: 12 });
  });

  it("returns only remote users from getUsers and notifies on changes", async () => {
    const aw = new FakeAwareness();
    const rootEntity = new Root({ name: "root" });
    const { plexus } = await initTestPlexus<Root>(rootEntity, {}, aw as any);

    // Local state exists but should be filtered out
    plexus.awareness.updateUserInfo({ name: "Local" });

    // Add a remote user and emit change
    aw.addRemote(2, { userId: "u2", userInfo: { name: "Remote" }, isFocused: true });

    const seen: Array<Map<number, any>> = [];
    const stop = plexus.awareness.onChange((users) => {
      seen.push(users);
    });
    aw.emit("change");

    expect(seen).toHaveLength(1);
    const users = seen[0];
    expect(users.size).toBe(1);
    const [, remote] = [...users.entries()][0];
    expect(remote.userInfo?.name).toBe("Remote");

    // Unsubscribe should remove listener
    stop();
    aw.emit("change");
    expect(seen).toHaveLength(1);
  });
});
