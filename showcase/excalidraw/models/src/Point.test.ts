import "./index.js";

import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import { ExcalidrawLineElement } from "./ExcalidrawLineElement.js";
import { writePoints } from "./Point.js";
import { Scene } from "./Scene.js";

describe("Point vertices", () => {
  it("reuses the same Point across ingest-like writes", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    const line = new ExcalidrawLineElement();
    scene.children.push(line);
    scene.register(line, line.uuid);

    writePoints(line.vertices, [
      [0, 0],
      [10, 0],
    ]);
    expect(line.vertices).toHaveLength(2);
    const a = line.vertices[0]!;
    const b = line.vertices[1]!;

    writePoints(line.vertices, [
      [1, 2],
      [10, 0],
      [20, 4],
    ]);
    expect(line.vertices[0]).toBe(a);
    expect(line.vertices[1]).toBe(b);
    expect(a.x).toBe(1);
    expect(a.y).toBe(2);
    expect(line.vertices).toHaveLength(3);

    writePoints(line.vertices, [[1, 2]]);
    expect(line.vertices).toHaveLength(1);
    expect(line.vertices[0]).toBe(a);
    expect(b.isDetached).toBe(true);
  });
});
