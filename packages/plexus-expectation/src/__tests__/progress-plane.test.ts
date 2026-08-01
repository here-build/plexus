/**
 * Live progress: one awareness clientId per Expectation on the hub.
 * Local = ephemeral Y.Doc + hub (no server). Peer = two hubs + encode/apply.
 */
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  PlexusAwareness,
  PlexusModel,
  resetLocalIDs,
  syncing,
} from "@here.build/plexus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Expectation } from "../app/index.js";
import { LaunchDefinition, Orchestration } from "../orchestration/index.js";
import type { ProgressMode } from "../app/progress-plane.js";
import { PewTestHost } from "./_helpers/test-host.js";

@syncing("test:ProgressE")
class ProgressE extends Expectation {
  static readonly kind = "test.progress";
  @syncing accessor payload: string = "";
}

@syncing("test:ProgressForest")
class ProgressForest extends PlexusModel {
  @syncing.child accessor orchestration: Orchestration = new Orchestration();
  @syncing.child.list accessor openWork: ProgressE[] = [];
}

function plan(mode: ProgressMode = "lww", emits = true): LaunchDefinition {
  return new LaunchDefinition({
    launchMode: "inprocess",
    emitsProgress: emits,
    progressMode: mode,
  });
}

function withHub(run: (hub: PlexusAwareness) => void): void {
  const doc = new Y.Doc();
  const hub = new PlexusAwareness(doc);
  Expectation.bindProgressHub(hub);
  try {
    run(hub);
  } finally {
    Expectation.bindProgressHub(null);
    doc.destroy();
  }
}

describe("Expectation live presence — one clientId per E", () => {
  beforeEach(() => {
    resetLocalIDs();
    Expectation.bindProgressHub(null);
    Expectation.appendCap = 32;
  });
  afterEach(() => {
    Expectation.bindProgressHub(null);
    Expectation.appendCap = 32;
  });

  it("positive: attach mints client + processorClientId; LWW progress", () => {
    withHub((hub) => {
      const E = new ProgressE();
      E.attachLivePresence();
      expect(E.processorClientId).not.toBe(0);
      expect(E.processorClientId).not.toBe(hub.clientID);
      expect(Expectation.hasLocalLivePresence(E)).toBe(true);

      E.reportProgress({ n: 1 });
      E.reportProgress({ n: 2 });
      expect(E.progress).toEqual({ n: 2 });
    });
  });

  it("positive: append mode caps ring on the same client", () => {
    withHub(() => {
      Expectation.appendCap = 3;
      const E = new ProgressE();
      E.attachLivePresence();
      E.reportProgress("a", "append");
      E.reportProgress("b", "append");
      E.reportProgress("c", "append");
      E.reportProgress("d", "append");
      expect(E.progress).toEqual(["b", "c", "d"]);
    });
  });

  it("positive: two Expectations → two clientIds, isolated progress", () => {
    withHub(() => {
      const a = new ProgressE();
      const b = new ProgressE();
      a.attachLivePresence();
      b.attachLivePresence();
      expect(a.processorClientId).not.toBe(b.processorClientId);
      a.reportProgress("A");
      b.reportProgress("B");
      expect(a.progress).toBe("A");
      expect(b.progress).toBe("B");
    });
  });

  it("positive: detach clears processorClientId and progress", () => {
    withHub(() => {
      const E = new ProgressE();
      E.attachLivePresence();
      E.reportProgress({ x: 1 });
      E.detachLivePresence();
      expect(E.processorClientId).toBe(0);
      expect(E.progress).toBeUndefined();
      expect(Expectation.hasLocalLivePresence(E)).toBe(false);
    });
  });

  it("negative: no hub → attach no-op, report no-op", () => {
    Expectation.bindProgressHub(null);
    const E = new ProgressE();
    E.attachLivePresence();
    expect(E.processorClientId).toBe(0);
    E.reportProgress({ should: "vanish" });
    expect(E.progress).toBeUndefined();
  });

  it("negative: mode none does not write", () => {
    withHub(() => {
      const E = new ProgressE();
      E.attachLivePresence();
      E.reportProgress({ n: 1 }, "none");
      expect(E.progress).toBeUndefined();
    });
  });

  it("negative: report without attach is no-op", () => {
    withHub(() => {
      const E = new ProgressE();
      E.reportProgress({ n: 1 });
      expect(E.progress).toBeUndefined();
    });
  });
});

describe("Orchestrator → live client (PewTestHost)", () => {
  let host: PewTestHost | undefined;

  beforeEach(() => {
    resetLocalIDs();
    Expectation.bindProgressHub(null);
  });
  afterEach(() => {
    host?.dispose();
    Expectation.bindProgressHub(null);
  });

  function forestWith(E: ProgressE, mode: ProgressMode = "lww", emits = true): ProgressForest {
    return new ProgressForest({
      orchestration: new Orchestration({
        actors: new Map([[ProgressE.kind, plan(mode, emits)]]),
      }),
      openWork: [E],
    });
  }

  it("positive: progress emit lands mid-flight; complete detaches", () => {
    const E = new ProgressE();
    let mid: unknown;
    host = new PewTestHost(forestWith(E), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { step: 1 } });
        emit({ type: "progress", epoch: input.epoch, patch: { step: 2 } });
        mid = E.progress;
        emit({ type: "complete", epoch: input.epoch });
        return { abort() {}, aborted: false };
      },
    });
    host.activate(E);
    expect(mid).toEqual({ step: 2 });
    expect(E.progress).toBeUndefined();
    expect(E.processorClientId).toBe(0);
  });

  it("negative: emitsProgress false → no live write", () => {
    const E = new ProgressE();
    let mid: unknown;
    host = new PewTestHost(forestWith(E, "lww", false), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { n: 1 } });
        mid = E.progress;
        emit({ type: "complete", epoch: input.epoch });
        return { abort() {}, aborted: false };
      },
    });
    host.activate(E);
    expect(mid).toBeUndefined();
  });

  it("positive: cancelTree detaches live client", () => {
    const E = new ProgressE();
    host = new PewTestHost(forestWith(E), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { x: 1 } });
        return { abort() {}, aborted: false };
      },
    });
    host.activate(E);
    expect(E.progress).toEqual({ x: 1 });
    expect(E.processorClientId).not.toBe(0);
    host.cancelTree(E);
    expect(E.progress).toBeUndefined();
    expect(E.processorClientId).toBe(0);
  });

  it("positive: markAwaitingRebind detaches", () => {
    const E = new ProgressE();
    host = new PewTestHost(forestWith(E), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { live: 1 } });
        return { abort() {}, aborted: false };
      },
    });
    host.activate(E);
    expect(E.progress).toEqual({ live: 1 });
    host.markAwaitingRebind(E, { reason: "test", incrementRebind: true });
    expect(E.progress).toBeUndefined();
    expect(E.processorClientId).toBe(0);
  });

  it("positive: fail emit detaches", () => {
    const E = new ProgressE();
    host = new PewTestHost(forestWith(E), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { n: 1 } });
        emit({ type: "fail", epoch: input.epoch, reason: "test" });
        return { abort() {}, aborted: false };
      },
    });
    host.activate(E);
    expect(E.progress).toBeUndefined();
    expect(E.processorClientId).toBe(0);
  });

  it("positive: disposeLease detaches", () => {
    const E = new ProgressE();
    host = new PewTestHost(forestWith(E), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { x: 1 } });
        return { abort() {}, aborted: false };
      },
    });
    host.activate(E);
    expect(E.progress).toEqual({ x: 1 });
    host.disposeLease();
    expect(E.progress).toBeUndefined();
  });

  it("positive: start throw after progress — failStart detaches", () => {
    const E = new ProgressE();
    host = new PewTestHost(forestWith(E), {
      [ProgressE.kind]: (input, emit) => {
        emit({ type: "progress", epoch: input.epoch, patch: { leaked: true } });
        throw new Error("boom");
      },
    });
    host.activate(E);
    expect(E.progress).toBeUndefined();
    expect(E.processorClientId).toBe(0);
  });
});

describe("Peer read — processorClientId + remote presence", () => {
  beforeEach(() => {
    resetLocalIDs();
    Expectation.bindProgressHub(null);
  });
  afterEach(() => {
    Expectation.bindProgressHub(null);
  });

  it("positive: peer hub reads progress via processorClientId (no local client)", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const hubA = new PlexusAwareness(docA);
    const hubB = new PlexusAwareness(docB);

    Expectation.bindProgressHub(hubA);
    const writer = new ProgressE();
    writer.attachLivePresence();
    writer.reportProgress({ stream: "hello" });
    const cid = writer.processorClientId;

    applyAwarenessUpdate(hubB, encodeAwarenessUpdate(hubA, [...hubA.states.keys()]), "remote");

    // Reader process: hub B only, pointer on a peer-side view of the debt
    Expectation.bindProgressHub(hubB);
    const reader = new ProgressE();
    reader.processorClientId = cid;
    expect(Expectation.hasLocalLivePresence(reader)).toBe(false);
    expect(reader.progress).toEqual({ stream: "hello" });

    docA.destroy();
    docB.destroy();
  });

  it("positive: LWW latest wins across sync", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const hubA = new PlexusAwareness(docA);
    const hubB = new PlexusAwareness(docB);
    Expectation.bindProgressHub(hubA);
    const writer = new ProgressE();
    writer.attachLivePresence();
    writer.reportProgress({ n: 1 });
    writer.reportProgress({ n: 2 });
    const cid = writer.processorClientId;
    applyAwarenessUpdate(hubB, encodeAwarenessUpdate(hubA, [...hubA.states.keys()]), "remote");
    Expectation.bindProgressHub(hubB);
    const reader = new ProgressE();
    reader.processorClientId = cid;
    expect(reader.progress).toEqual({ n: 2 });
    docA.destroy();
    docB.destroy();
  });

  it("positive: clear pointer → no progress even if stale peer fields remain", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const hubA = new PlexusAwareness(docA);
    const hubB = new PlexusAwareness(docB);
    Expectation.bindProgressHub(hubA);
    const writer = new ProgressE();
    writer.attachLivePresence();
    writer.reportProgress({ n: 1 });
    const cid = writer.processorClientId;
    applyAwarenessUpdate(hubB, encodeAwarenessUpdate(hubA, [...hubA.states.keys()]), "remote");

    Expectation.bindProgressHub(hubB);
    const reader = new ProgressE();
    reader.processorClientId = cid;
    expect(reader.progress).toEqual({ n: 1 });
    reader.processorClientId = 0;
    expect(reader.progress).toBeUndefined();

    docA.destroy();
    docB.destroy();
  });
});
