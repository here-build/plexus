import { Plexus } from "@here.build/plexus";
import { Flow, FlowNode } from "@here.build/plexus-xyflow-models";
import { describe, expect, it } from "vitest";

import { defaultRoot } from "./seed.js";

describe("defaultRoot", () => {
  it("is a Flow whose group owns its children", () => {
    const flow = Plexus.bootstrap(defaultRoot()).root as Flow;
    expect(flow.children).toHaveLength(4);
    expect(flow.nodes.size).toBe(14);

    const studio = flow.children.find((n) => n instanceof FlowNode && n.label === "studio");
    expect(studio).toBeTruthy();
    expect(studio!.type).toBe("group");
    expect(studio!.children).toHaveLength(2);
    expect(studio!.children[0]!.children).toHaveLength(3);
    expect(flow.nodes.get(studio!.children[0]!.id)).toBe(studio!.children[0]);
    expect(flow.edgeList).toHaveLength(8);
    expect(flow.edgeList.some((edge) => edge.label === "handoff")).toBe(true);
    expect(flow.edgeList[0]!.source).toBeInstanceOf(FlowNode);
  });
});
