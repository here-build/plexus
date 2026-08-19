import { Scene } from "@here.build/plexus-excalidraw-models";
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";

import {
  ExcalidrawAwareness,
  PRESENCE_CURSOR_FIELD,
  PRESENCE_NAME_FIELD,
  PRESENCE_SELECTION_FIELD,
  type PresenceAwarenessShape,
} from "./ExcalidrawAwareness.js";
import { ExcalidrawPlexus } from "./ExcalidrawPlexus.js";

function boot() {
  const plexus = ExcalidrawPlexus.bootstrap(new Scene()) as ExcalidrawPlexus;
  const aw = plexus.awareness;
  if (!(aw instanceof ExcalidrawAwareness)) throw new Error("expected ExcalidrawAwareness");
  return { plexus, scene: plexus.root, aw };
}

describe("core reads", () => {
  it("writes the live cursor field — canvas is the tree instance", () => {
    const { scene, aw } = boot();
    aw.setCursor(scene, { x: 120, y: -40 });

    const cursor = aw.cursor.get()!;
    expect(cursor.x).toBe(120);
    expect(cursor.y).toBe(-40);
    expect(cursor.canvas).toBe(scene);
    expect(aw.cursor.clientIds).toEqual([aw.clientID]);
    expect(aw.cursor.getOthers().size).toBe(0);
  });

  it("keeps coordinates verbatim — the canvas defines the space", () => {
    const { scene, aw } = boot();
    aw.setCursor(scene, { x: 4820.5, y: -1337.25 });
    expect(aw.cursor.get()).toMatchObject({ x: 4820.5, y: -1337.25 });
  });

  it("clears only when the field still names this canvas", () => {
    const { scene, aw } = boot();
    aw.setCursor(scene, { x: 1, y: 2 });
    expect(aw.cursor.get()).not.toBeNull();
    aw.setCursor(scene, null);
    expect(aw.cursor.get()).toBeNull();
  });

  it("namespaces its fields so a co-resident awareness cannot collide", () => {
    const keys: (keyof PresenceAwarenessShape)[] = [
      PRESENCE_CURSOR_FIELD,
      PRESENCE_NAME_FIELD,
      PRESENCE_SELECTION_FIELD,
    ];
    expect(keys).toEqual(["presence:cursor", "presence:name", "presence:selection"]);
  });
});

describe("ExcalidrawAwareness", () => {
  it("is what plexus.awareness is when the host constructs it", () => {
    const { aw } = boot();
    expect(aw).toBeInstanceOf(ExcalidrawAwareness);
  });

  it("writes shape fields through getField / setField", () => {
    const { scene, aw } = boot();
    aw.setField(PRESENCE_NAME_FIELD, "Ada");
    expect(aw.getField(PRESENCE_NAME_FIELD)).toBe("Ada");
    aw.setField(PRESENCE_CURSOR_FIELD, { canvas: scene, x: 1, y: 2 });
    expect(aw.getField(PRESENCE_CURSOR_FIELD)).toMatchObject({ x: 1, y: 2 });
  });

  it("lets a subclass replace identity by constructing its awareness", () => {
    class HostAwareness extends ExcalidrawAwareness {
      getClientIdentity(_clientId: number) {
        return { key: "host" };
      }
    }
    class HostPlexus extends ExcalidrawPlexus {
      override awareness = new HostAwareness(this.doc);
    }
    const plexus = HostPlexus.bootstrap(new Scene()) as HostPlexus;
    expect(plexus.awareness.getClientIdentity(1).key).toBe("host");
    plexus.destroy();
  });
});

describe("FieldAwareness lanes", () => {
  it("re-runs a reaction when the cursor lane changes", () => {
    const { scene, aw } = boot();

    let seen = 0;
    const stop = autorun(() => {
      aw.cursor.get();
      seen++;
    });
    expect(seen).toBe(1);

    aw.setCursor(scene, { x: 1, y: 1 });
    aw.setCursor(scene, { x: 2, y: 2 });
    expect(seen).toBeGreaterThan(1);

    stop();
  });

  it("lists the local session on the name lane after setName", () => {
    const { aw } = boot();
    aw.setName("Ada");
    expect(aw.name.get()).toBe("Ada");
    expect(aw.name.clientIds).toEqual([aw.clientID]);
  });
});

describe("identity", () => {
  it("resolves a session to itself by default", () => {
    const { aw } = boot();
    expect(aw.getClientIdentity(aw.clientID).key).toBe(String(aw.clientID));
  });

  it("carries the display name when one is published", () => {
    const { aw } = boot();
    aw.setName("Ada");
    expect(aw.getClientIdentity(aw.clientID).displayName).toBe("Ada");
  });
});
