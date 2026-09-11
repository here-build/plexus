import { Plexus } from "@here.build/plexus";
import { Flow, FlowNode } from "@here.build/plexus-xyflow-models";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeFlowSeed } from "./flow-seed.js";

describe("encodeFlowSeed", () => {
  it("is a document a peer can connect to — not a second bootstrap", () => {
    const guid = "room-1";
    const bytes = encodeFlowSeed(guid);
    const doc = new Y.Doc({ guid });
    Y.applyUpdate(doc, bytes);

    const plexus = Plexus.connect(doc);
    const flow = plexus.root as Flow;
    expect(flow.children.length).toBe(4);
    expect(flow.children.some((n) => n instanceof FlowNode && n.type === "group")).toBe(true);
    expect(flow.snapshotEdges()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "e-caption-notes",
          source: "n-caption",
          target: "n-notes",
          label: "handoff",
        }),
      ]),
    );
    doc.destroy();
  });
});
