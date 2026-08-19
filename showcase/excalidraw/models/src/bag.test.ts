import "./index.js";

import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import { ExcalidrawFrameElement } from "./ExcalidrawFrameElement.js";
import { ExcalidrawRectangleElement } from "./ExcalidrawRectangleElement.js";
import { ExcalidrawTextElement } from "./ExcalidrawTextElement.js";
import { Scene } from "./Scene.js";

describe("writable bag", () => {
  it("assigns the editor bag onto a live node", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const box = scene.createElement("rectangle");
    scene.register(box, "box");
    const frame = scene.createElement("frame");
    scene.register(frame, "frame");
    scene.children.push(frame);

    Object.assign(box, {
      x: 15,
      y: 20,
      width: 80,
      height: 40,
      groupIds: ["g1"],
      roundness: { type: 3, value: 12 },
      frameId: "frame",
      version: 99,
      versionNonce: 7,
      updated: 123,
      seed: 4,
      boundElements: [{ id: "a", type: "arrow" }],
      isDeleted: false,
    });

    expect(box).toBeInstanceOf(ExcalidrawRectangleElement);
    expect(box.x).toBe(15);
    expect(box.y).toBe(20);
    expect(box.groupIds).toEqual(["g1"]);
    expect(box.roundness).toEqual({ type: 3, value: 12 });
    expect(box.parent).toBe(frame);
    expect(box.version).toBe(1);
    expect(box.versionNonce).toBe(0);
    expect(box.updated).toBe(0);
    expect(box.boundElements).toBeNull();
    expect(box.isDeleted).toBe(false);
    expect(frame).toBeInstanceOf(ExcalidrawFrameElement);
  });

  it("isDeleted detaches and leaves the node registered", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const frame = new ExcalidrawFrameElement();
    const box = new ExcalidrawRectangleElement();
    scene.children.push(frame, box);
    scene.register(frame, "frame");
    scene.register(box, "box");

    box.isDeleted = true;
    expect(box.isDetached).toBe(true);
    expect(scene.children).toEqual([frame]);
    expect(scene.elements.get("box")).toBe(box);
  });

  it("containerId is a pointer write", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const box = new ExcalidrawRectangleElement();
    const note = new ExcalidrawTextElement();
    scene.children.push(box, note);
    scene.register(box, "box");
    scene.register(note, "note");

    note.containerId = "box";
    expect(note.container).toBe(box);
    expect(box.boundElements).toEqual([{ id: "note", type: "text" }]);
    note.containerId = null;
    expect(note.container).toBeNull();
  });
});
