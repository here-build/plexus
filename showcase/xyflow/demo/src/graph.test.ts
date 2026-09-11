import { Plexus } from "@here.build/plexus";
import { defaultFlow, Flow } from "@here.build/plexus-xyflow-models";
import { describe, expect, it } from "vitest";

import { addGroup, addUntitled, dropParentId } from "./graph.js";

describe("graph", () => {
  it("addUntitled lands inside a selected group", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const board = flow.getNode("n-board")!;
    const node = addUntitled(flow, { x: 300, y: 200 }, "extra", board);
    expect(node.parent).toBe(board);
    expect(node.x).toBe(300 - board.absOrigin().x);
    expect(node.y).toBe(200 - board.absOrigin().y);
    plexus.destroy();
  });

  it("addGroup wraps siblings and owns them", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const type = flow.getNode("n-type")!;
    const color = flow.getNode("n-color")!;
    const kit = flow.getNode("n-kit")!;
    const group = addGroup(flow, { x: 0, y: 0 }, [type, color]);
    expect(group.parent).toBe(kit);
    expect(group.type).toBe("group");
    expect(type.parent).toBe(group);
    expect(color.parent).toBe(group);
    expect(kit.children).toContain(group);
    expect(kit.children.includes(type)).toBe(false);
    plexus.destroy();
  });

  it("dropParentId picks the innermost group under the node's center", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const board = flow.getNode("n-board")!;
    const origin = board.absOrigin();
    expect(dropParentId(flow, "n-brief", { x: origin.x + 40, y: origin.y + 40 })).toBe("n-board");
    expect(dropParentId(flow, "n-brief", { x: 0, y: 0 })).toBeNull();
    expect(dropParentId(flow, "n-studio", { x: origin.x + 40, y: origin.y + 40 })).toBeNull();
    plexus.destroy();
  });
});
