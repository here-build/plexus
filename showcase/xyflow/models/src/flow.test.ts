import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import { defaultFlow } from "./default-flow.js";
import { Flow } from "./Flow.js";
import { FlowNode } from "./FlowNode.js";

describe("Flow", () => {
  it("snapshots parents before children and edges as pointers", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const nodes = flow.snapshotNodes();
    const studioAt = nodes.findIndex((n) => n.id === "n-studio");
    const boardAt = nodes.findIndex((n) => n.id === "n-board");
    const childAt = nodes.findIndex((n) => n.id === "n-hero");
    expect(studioAt).toBeGreaterThanOrEqual(0);
    expect(boardAt).toBeGreaterThan(studioAt);
    expect(childAt).toBeGreaterThan(boardAt);
    expect(nodes[boardAt]?.parentId).toBe("n-studio");
    expect(nodes[childAt]?.parentId).toBe("n-board");
    expect(flow.snapshotEdges()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "e-brief-hero", source: "n-brief", target: "n-hero" }),
        expect.objectContaining({
          id: "e-caption-notes",
          source: "n-caption",
          target: "n-notes",
          label: "handoff",
        }),
        expect.objectContaining({ id: "e-signoff-ship", source: "n-signoff", target: "n-ship" }),
      ]),
    );
    plexus.destroy();
  });

  it("a group owns its children; an edge points, including across groups", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const studio = flow.getNode("n-studio")!;
    const board = flow.getNode("n-board")!;
    const hero = flow.getNode("n-hero")!;
    expect(hero.parent).toBe(board);
    expect(board.parent).toBe(studio);
    expect(studio.owns(hero)).toBe(true);
    expect(board.children).toContain(hero);

    const handoff = flow.getEdge("e-caption-notes")!;
    expect(handoff.source).toBe(flow.getNode("n-caption"));
    expect(handoff.target).toBe(flow.getNode("n-notes"));
    expect(handoff.source?.parent).toBe(flow.getNode("n-board"));
    expect(handoff.target?.parent).toBe(flow.getNode("n-review"));
    plexus.destroy();
  });

  it("applyNodeChanges writes position and skips select", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const start = flow.getNode("n-brief")!;
    flow.applyNodeChanges([
      { id: "n-brief", type: "select", selected: true },
      { id: "n-brief", type: "position", position: { x: 100, y: 120 } },
    ]);
    expect(start.x).toBe(100);
    expect(start.y).toBe(120);
    plexus.destroy();
  });

  it("removing a node drops edges that pointed at it", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    flow.applyNodeChanges([{ id: "n-brief", type: "remove" }]);
    expect(flow.getNode("n-brief")).toBeNull();
    expect(flow.getEdge("e-brief-hero")).toBeNull();
    expect(flow.getNode("n-hero")).toBeTruthy();
    plexus.destroy();
  });

  it("removing a group takes the children it owns", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    flow.applyNodeChanges([{ id: "n-board", type: "remove" }]);
    expect(flow.getNode("n-board")).toBeNull();
    expect(flow.getNode("n-hero")).toBeNull();
    expect(flow.getNode("n-caption")).toBeNull();
    expect(flow.getNode("n-studio")).toBeTruthy();
    expect(flow.getNode("n-brief")).toBeTruthy();
    expect(flow.getEdge("e-brief-hero")).toBeNull();
    expect(flow.getEdge("e-caption-notes")).toBeNull();
    expect(flow.getEdge("e-type-caption")).toBeNull();
    plexus.destroy();
  });

  it("connect adds an edge; parentId reparents onto a group", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    flow.connect({ source: "n-brief", target: "n-ship", sourceHandle: null, targetHandle: null });
    expect(flow.getEdge("e-n-brief-n-ship")?.source).toBe(flow.getNode("n-brief"));

    const extra = new FlowNode({ type: "default", x: 10, y: 10, label: "parked" });
    flow.registerNode(extra, "n-parked");
    flow.children.push(extra);
    extra.parentId = "n-board";
    expect(extra.parent).toBe(flow.getNode("n-board"));
    expect(flow.children.includes(extra)).toBe(false);
    expect(extra.id).toBe("n-parked");
    plexus.destroy();
  });

  it("addNode materializes a model the graph owns", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const node = flow.addNode({ id: "n-extra", x: 10, y: 20, label: "extra" });
    expect(flow.getNode("n-extra")).toBe(node);
    expect(flow.children).toContain(node);
    expect(node.id).toBe("n-extra");
    expect(node.label).toBe("extra");
    plexus.destroy();
  });

  it("reparent moves ownership and keeps the content-space origin", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const hero = flow.getNode("n-hero")!;
    const before = hero.absOrigin();
    flow.reparent("n-hero", "n-review");
    expect(hero.parent).toBe(flow.getNode("n-review"));
    expect(flow.getNode("n-board")!.children.includes(hero)).toBe(false);
    expect(hero.absOrigin()).toEqual(before);

    flow.reparent("n-hero", null);
    expect(hero.parent).toBe(flow);
    expect(flow.children).toContain(hero);
    expect(hero.absOrigin()).toEqual(before);
    plexus.destroy();
  });

  it("reparent refuses a cycle into a descendant", () => {
    const plexus = Plexus.bootstrap(defaultFlow());
    const flow = plexus.root as Flow;
    const studio = flow.getNode("n-studio")!;
    flow.reparent("n-studio", "n-board");
    expect(studio.parent).toBe(flow);
    expect(flow.getNode("n-board")!.parent).toBe(studio);
    plexus.destroy();
  });
});
