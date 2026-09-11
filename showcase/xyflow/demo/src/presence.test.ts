import { defaultFlow, Flow } from "@here.build/plexus-xyflow-models";
import { describe, expect, it } from "vitest";

import { remotesOnNode } from "./presence.js";
import { DemoPlexus } from "./sync/DemoPlexus.js";

describe("remotesOnNode", () => {
  it("is empty when only this client has a selection", () => {
    const plexus = DemoPlexus.bootstrap(defaultFlow()) as DemoPlexus;
    const flow = plexus.root as Flow;
    const caption = flow.getNode("n-caption")!;
    plexus.awareness.setSelection(flow, [caption]);
    expect(remotesOnNode(plexus.awareness, caption)).toEqual([]);
    expect(remotesOnNode(plexus.awareness, null)).toEqual([]);
    plexus.destroy();
  });
});
