import { Plexus } from "@here.build/plexus";
import { defaultFlow, Flow } from "@here.build/plexus-xyflow-models";
import { describe, expect, it } from "vitest";

import { addUntitled } from "./graph.js";
import { absoluteCenter, focusNode, ownedTree, pointerList } from "./inspect.js";

describe("inspect", () => {
  it("shows ownership as a tree and edges as pointers, not id strings", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const tree = ownedTree(flow);
    expect(tree.map((n) => n.label)).toEqual(["brief", "studio", "review", "ship"]);
    const studio = tree.find((n) => n.label === "studio");
    expect(studio?.children.map((n) => n.label)).toEqual(["board", "kit"]);
    expect(studio?.kind).toBe("FlowNode");
    const board = studio?.children.find((n) => n.label === "board");
    expect(board?.children.map((n) => n.label)).toEqual(["hero", "caption", "mark"]);

    const pointers = pointerList(flow);
    expect(pointers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "FlowEdge",
          sourceLabel: "caption",
          targetLabel: "notes",
        }),
      ]),
    );

    const caption = flow.getNode("n-caption")!;
    const focus = focusNode(flow, caption);
    expect(focus.ownedBy).toEqual({ kind: "FlowNode", id: "n-board", label: "board" });
    expect(focus.pointers.some((p) => p.targetLabel === "notes")).toBe(true);

    const at = absoluteCenter(caption);
    expect(at.x).toBe(220 + 20 + 28 + 76);
    expect(at.y).toBe(40 + 44 + 148 + 28);
    plexus.destroy();
  });

  it("addUntitled is a FlowNode the graph owns", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const node = addUntitled(flow, { x: 8, y: 9 }, "extra");
    expect(flow.children).toContain(node);
    expect(node.label).toBe("extra");
    expect(ownedTree(flow).some((n) => n.id === node.id)).toBe(true);
    plexus.destroy();
  });
});
