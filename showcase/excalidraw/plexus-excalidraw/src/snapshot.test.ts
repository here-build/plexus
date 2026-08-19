import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import type * as X from "@excalidraw/excalidraw/element/types";

import {
  ExcalidrawFrameElement,
  ExcalidrawRectangleElement,
  ExcalidrawTextElement,
  Scene,
} from "@here.build/plexus-excalidraw-models";
import { snapshot, stampEditorVersions } from "./snapshot.js";

function drawn(
  partial: Partial<X.ExcalidrawRectangleElement> & Pick<X.ExcalidrawRectangleElement, "id" | "x">,
): X.ExcalidrawRectangleElement {
  return {
    type: "rectangle",
    y: 0,
    width: 40,
    height: 20,
    angle: 0 as X.ExcalidrawRectangleElement["angle"],
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 0,
    updated: 0,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    index: null,
    locked: false,
    link: null,
    roundness: null,
    ...partial,
  };
}

function own(
  scene: Scene,
  ...nodes: InstanceType<
    typeof ExcalidrawTextElement | typeof ExcalidrawRectangleElement | typeof ExcalidrawFrameElement
  >[]
) {
  for (const node of nodes) {
    if (node.parent == null) scene.children.push(node);
    scene.register(node, node.id || node.uuid);
  }
}

describe("scene view", () => {
  it("round-trips a frame-owned text node as frameId, not a second parent", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const frame = new ExcalidrawFrameElement({
      name: "box",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
    const note = new ExcalidrawTextElement({
      text: "hi",
      x: 10,
      y: 10,
      width: 80,
      height: 30,
    });
    scene.children.push(frame);
    frame.children.push(note);
    scene.register(frame, frame.uuid);
    scene.register(note, note.uuid);

    expect(note.parent).toBe(frame);
    expect(note.frameId).toBe(scene.id);

    const elements = snapshot(scene);
    const drawnNote = elements.find((e) => e.id === note.id);
    expect(drawnNote?.frameId).toBe(frame.id);
    expect(scene.children.map((n) => n.id)).toEqual([frame.id]);

    scene.ingest(elements);
    expect(note.parent).toBe(frame);
    expect(scene.children.length).toBe(1);
    expect(elements.map((e) => e.id)).toEqual([note.id, frame.id]);
  });

  it("keeps the editor id and the same node across ingest ticks", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;

    scene.ingest([drawn({ id: "nano-1", x: 10 })]);
    expect(scene.elements.size).toBe(1);
    const node = scene.elements.get("nano-1");
    expect(node).toBeTruthy();
    expect(node!.x).toBe(10);
    expect(node!.isDetached).toBe(false);

    const again = snapshot(scene);
    expect(again[0]!.id).toBe("nano-1");
    again[0] = { ...again[0]!, x: 20 };
    scene.ingest(again);
    expect(scene.elements.size).toBe(1);
    expect(scene.elements.get("nano-1")).toBe(node);
    expect(node!.x).toBe(20);
  });

  it("registers without parenting, then appears when added to the tree", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const note = new ExcalidrawTextElement({ text: "pending", x: 0, y: 0, width: 40, height: 20 });
    scene.register(note, "pending");

    expect(scene.elements.get("pending")).toBe(note);
    expect(note.isDetached).toBe(true);
    expect(snapshot(scene)).toHaveLength(0);

    scene.children.push(note);
    expect(note.isDetached).toBe(false);
    expect(snapshot(scene).map((e) => e.id)).toEqual(["pending"]);
  });

  it("ingest of an empty array detaches live nodes", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const note = new ExcalidrawTextElement({ text: "stay", x: 0, y: 0, width: 40, height: 20 });
    own(scene, note);
    const id = note.id;
    scene.ingest([]);
    expect(scene.children).toHaveLength(0);
    expect(note.isDetached).toBe(true);
    expect(scene.elements.get(id)).toBe(note);
  });

  it("orders siblings by fractional index", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    scene.ingest([
      drawn({ id: "back", x: 0, index: "a1" as X.ExcalidrawElement["index"] }),
      drawn({ id: "front", x: 10, index: "a0" as X.ExcalidrawElement["index"] }),
    ]);
    expect(scene.children.map((n) => n.index)).toEqual(["a1", "a0"]);
    expect(snapshot(scene).map((e) => e.index)).toEqual(["a0", "a1"]);
  });

  it("keeps a deleted node registered after it leaves the tree", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    scene.ingest([drawn({ id: "gone", x: 0 })]);
    const node = scene.elements.get("gone")!;
    scene.ingest([drawn({ id: "stays", x: 1 })]);
    expect(scene.elements.get("gone")).toBe(node);
    expect(node.isDetached).toBe(true);
    expect(scene.elements.get("stays")?.isDetached).toBe(false);
    expect(snapshot(scene).map((e) => e.id)).toEqual(["stays"]);
  });

  it("stampEditorVersions bumps version only when the bag changed", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const note = new ExcalidrawTextElement({ text: "a", x: 0, y: 0, width: 40, height: 20 });
    own(scene, note);

    const clocks = new Map<string, { json: string; version: number }>();
    const first = stampEditorVersions(snapshot(scene), clocks);
    const second = stampEditorVersions(snapshot(scene), clocks);
    expect(first[0]!.version).toBe(1);
    expect(second[0]!.version).toBe(1);

    note.text = "b";
    const third = stampEditorVersions(snapshot(scene), clocks);
    expect(third[0]!.version).toBe(2);
    expect(third[0]!.id).toBe(note.id);
  });

  it("reparents from the editor frameId", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const frame = new ExcalidrawFrameElement({ name: "box", x: 0, y: 0, width: 200, height: 200 });
    const box = new ExcalidrawRectangleElement({ x: 10, y: 10, width: 40, height: 40 });
    scene.children.push(frame, box);
    scene.register(frame, frame.uuid);
    scene.register(box, box.uuid);

    scene.ingest([
      { ...snapshot(scene).find((e) => e.id === frame.id)!, frameId: null },
      { ...snapshot(scene).find((e) => e.id === box.id)!, frameId: frame.id },
    ]);
    expect(box.parent).toBe(frame);

    scene.ingest([
      { ...snapshot(scene).find((e) => e.id === frame.id)!, frameId: null },
      { ...snapshot(scene).find((e) => e.id === box.id)!, frameId: null },
    ]);
    expect(box.parent).toBe(scene);
  });

  it("does not invent a second point on a one-vertex line", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    scene.ingest([
      {
        ...drawn({ id: "stroke", x: 0 }),
        type: "line",
        points: [[0, 0]],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      } as X.ExcalidrawLinearElement,
    ]);
    const drawnLine = snapshot(scene)[0] as X.ExcalidrawLinearElement;
    expect(drawnLine.points).toEqual([[0, 0]]);
  });

  it("throws on an unknown editor type", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    expect(() =>
      scene.ingest([
        { ...drawn({ id: "x", x: 0 }), type: "not-a-type" } as unknown as X.ExcalidrawElement,
      ]),
    ).toThrow(/unknown element type/);
  });
});
