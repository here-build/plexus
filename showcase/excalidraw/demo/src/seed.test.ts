import { Plexus } from "@here.build/plexus";
import {
  ExcalidrawFrameElement,
  ExcalidrawTextElement,
  Scene,
} from "@here.build/plexus-excalidraw-models";
import { describe, expect, it } from "vitest";

import { defaultRoot } from "./seed.js";

describe("defaultRoot", () => {
  it("is a Scene whose frame owns its child", () => {
    const scene = Plexus.bootstrap(defaultRoot()).root as Scene;
    const live = scene.getNonDeletedElements();
    expect(live).toHaveLength(4);
    expect(scene.elements.size).toBe(4);
    expect(scene.children).toHaveLength(3);

    const frame = scene.children.find((n) => n instanceof ExcalidrawFrameElement);
    expect(frame).toBeTruthy();
    expect(frame!.name).toBe("owned");
    expect(frame!.children).toHaveLength(1);
    expect(frame!.children[0]).toBeInstanceOf(ExcalidrawTextElement);
    expect(scene.elements.get(frame!.children[0]!.id)).toBe(frame!.children[0]);
  });
});
