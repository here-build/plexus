import { describe, expect, it } from "vitest";

import { ExcalidrawAwareness, ExcalidrawPlexus } from "./ExcalidrawPlexus.js";
import { Scene } from "@here.build/plexus-excalidraw-models";

describe("ExcalidrawPlexus", () => {
  it("bootstraps a Scene with presence-shaped awareness", () => {
    const plexus = ExcalidrawPlexus.bootstrap(new Scene());
    expect(plexus).toBeInstanceOf(ExcalidrawPlexus);
    expect(plexus.root).toBeInstanceOf(Scene);
    expect(plexus.awareness).toBeInstanceOf(ExcalidrawAwareness);
    const aw = plexus.awareness;
    if (!(aw instanceof ExcalidrawAwareness)) throw new Error("expected ExcalidrawAwareness");
    expect(typeof aw.hueFor(aw.clientID)).toBe("number");
    expect(aw.getAvatar(aw.clientID)).toMatch(/<svg/);
    plexus.destroy();
  });

  it("lets a subclass swap Awareness", () => {
    class HostAwareness extends ExcalidrawAwareness {
      getClientIdentity(_clientId: number) {
        return { key: "host" };
      }
    }
    class HostPlexus extends ExcalidrawPlexus {
      override awareness = new HostAwareness(this.doc);
    }
    const plexus = HostPlexus.bootstrap(new Scene());
    expect(plexus).toBeInstanceOf(HostPlexus);
    expect(plexus.awareness).toBeInstanceOf(HostAwareness);
    expect(plexus.awareness).toBeInstanceOf(HostAwareness);
    if (!(plexus.awareness instanceof HostAwareness)) throw new Error("expected HostAwareness");
    expect(plexus.awareness.getClientIdentity(1).key).toBe("host");
    plexus.destroy();
  });
});
