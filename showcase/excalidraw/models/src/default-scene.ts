import { ExcalidrawFrameElement } from "./ExcalidrawFrameElement.js";
import { ExcalidrawRectangleElement } from "./ExcalidrawRectangleElement.js";
import { ExcalidrawTextElement } from "./ExcalidrawTextElement.js";
import { Scene } from "./Scene.js";
import type { ExcalidrawAnyElement } from "./types.js";

/** Fresh Scene the first writer (the Worker) bootstraps into an empty room. */
export function defaultScene(): Scene {
  const note = new ExcalidrawTextElement({
    text: "one Scene — open another tab",
    x: 80,
    y: 80,
    width: 340,
    height: 60,
    backgroundColor: "#ffec99",
  });
  const box = new ExcalidrawRectangleElement({
    x: 80,
    y: 180,
    width: 160,
    height: 80,
    backgroundColor: "#a5d8ff",
  });
  const inside = new ExcalidrawTextElement({
    text: "child of the frame",
    x: 460,
    y: 130,
    width: 200,
    height: 40,
    backgroundColor: "#ffd8a8",
  });
  const frame = new ExcalidrawFrameElement({
    name: "owned",
    x: 440,
    y: 80,
    width: 260,
    height: 200,
    backgroundColor: "transparent",
    children: [inside],
  });
  return new Scene({
    children: [note, box, frame],
    elements: new Map<string, ExcalidrawAnyElement>([
      [crypto.randomUUID(), note],
      [crypto.randomUUID(), box],
      [crypto.randomUUID(), frame],
      [crypto.randomUUID(), inside],
    ]),
  });
}
