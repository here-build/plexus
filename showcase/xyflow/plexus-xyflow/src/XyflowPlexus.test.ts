import { describe, expect, it } from "vitest";

import { Flow } from "@here.build/plexus-xyflow-models";

import { XyflowAwareness, XyflowPlexus } from "./XyflowPlexus.js";

describe("XyflowPlexus", () => {
  it("bootstraps a Flow with presence-shaped awareness", () => {
    const plexus = XyflowPlexus.bootstrap(new Flow());
    expect(plexus).toBeInstanceOf(XyflowPlexus);
    expect(plexus.root).toBeInstanceOf(Flow);
    expect(plexus.awareness).toBeInstanceOf(XyflowAwareness);
    const aw = plexus.awareness;
    if (!(aw instanceof XyflowAwareness)) throw new Error("expected XyflowAwareness");
    expect(typeof aw.hueFor(aw.clientID)).toBe("number");
    expect(aw.getAvatar(aw.clientID)).toMatch(/<svg/);
    plexus.destroy();
  });
});
