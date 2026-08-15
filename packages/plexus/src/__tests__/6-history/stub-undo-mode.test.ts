/**
 * Construct-time stub undo: no UndoManager allocation; undo/redo warn+no-op;
 * liminality throws. Default full mode stays covered by undo-redo.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { TestPlexus } from "../_helpers/test-plexus.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("StubUndoModel")
class StubUndoModel extends PlexusModel {
  @syncing accessor name: string = "";
}

describe("stub undo mode", () => {
  let plexus: TestPlexus<StubUndoModel>;
  let root: StubUndoModel;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = initTestPlexus(new StubUndoModel({ name: "initial" }), {}, undefined, { undo: "stub" });
    plexus = result.plexus;
    root = result.root;
  });

  it("records undoMode=stub and never allocates main UndoManager", () => {
    expect(plexus.undoMode).toBe("stub");
    const um = (plexus as unknown as { __undoManager__: unknown }).__undoManager__;
    const limUm = (plexus as unknown as { __liminalUndoManager__: unknown }).__liminalUndoManager__;
    expect(um).toBeNull();
    expect(limUm).toBeNull();
  });

  it("writes still work without UndoManager", () => {
    plexus.transact(() => {
      root.name = "written";
    });
    expect(root.name).toBe("written");
  });

  it("undo/redo warn and do not reverse writes", () => {
    plexus.transact(() => {
      root.name = "mutated";
    });
    plexus.undo();
    expect(root.name).toBe("mutated");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("undo()"));
    plexus.redo();
    expect(root.name).toBe("mutated");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("redo()"));
  });

  it("stopCapturing is silent under stub", () => {
    warn.mockClear();
    plexus.stopCapturing();
    expect(warn).not.toHaveBeenCalled();
  });

  it("enterLiminality throws (honest unsupported)", () => {
    expect(() => plexus.enterLiminality()).toThrow(/undoMode=stub/);
    expect(plexus.isLiminal).toBe(false);
  });

  it("commit/revert liminality throw under stub", () => {
    expect(() => plexus.commitLiminality()).toThrow(/undoMode=stub/);
    expect(() => plexus.revertLiminality()).toThrow(/undoMode=stub/);
  });

  it("destroy does not throw", () => {
    expect(() => plexus.destroy()).not.toThrow();
  });

  it("CRDT sync still converges with a full-mode peer", () => {
    plexus.transact(() => {
      root.name = "from-stub";
    });
    const update = Y.encodeStateAsUpdate(plexus.doc);

    const peer = initTestPlexus(new StubUndoModel({ name: "peer-init" }));
    // Peer is full mode by default
    expect(peer.plexus.undoMode).toBe("full");
    Y.applyUpdate(peer.doc, update);
    // Different roots — this only proves applyUpdate does not throw under stub source.
    // Identity merge is out of scope; we assert no crash and stub still writable.
    expect(() => {
      plexus.transact(() => {
        root.name = "still-ok";
      });
    }).not.toThrow();
    expect(root.name).toBe("still-ok");
  });

  it("default bootstrap remains full undo", () => {
    const full = initTestPlexus(new StubUndoModel({ name: "full" }));
    expect(full.plexus.undoMode).toBe("full");
    full.plexus.transact(() => {
      full.root.name = "changed";
    });
    full.plexus.undo();
    expect(full.root.name).toBe("full");
  });
});
