import "./index.js";

import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import type * as X from "@excalidraw/excalidraw/element/types";

import { ExcalidrawArrowElement } from "./ExcalidrawArrowElement.js";
import { ExcalidrawDiamondElement } from "./ExcalidrawDiamondElement.js";
import { ExcalidrawEmbeddableElement } from "./ExcalidrawEmbeddableElement.js";
import { ExcalidrawEllipseElement } from "./ExcalidrawEllipseElement.js";
import { ExcalidrawFrameElement } from "./ExcalidrawFrameElement.js";
import { ExcalidrawFreeDrawElement } from "./ExcalidrawFreeDrawElement.js";
import { ExcalidrawIframeElement } from "./ExcalidrawIframeElement.js";
import { ExcalidrawImageElement } from "./ExcalidrawImageElement.js";
import { ExcalidrawLineElement } from "./ExcalidrawLineElement.js";
import { ExcalidrawMagicFrameElement } from "./ExcalidrawMagicFrameElement.js";
import { ExcalidrawRectangleElement } from "./ExcalidrawRectangleElement.js";
import { ExcalidrawTextElement } from "./ExcalidrawTextElement.js";
import { Scene } from "./Scene.js";

const KINDS: { type: X.ExcalidrawElement["type"]; cls: new () => object }[] = [
  { type: "rectangle", cls: ExcalidrawRectangleElement },
  { type: "diamond", cls: ExcalidrawDiamondElement },
  { type: "ellipse", cls: ExcalidrawEllipseElement },
  { type: "text", cls: ExcalidrawTextElement },
  { type: "line", cls: ExcalidrawLineElement },
  { type: "arrow", cls: ExcalidrawArrowElement },
  { type: "freedraw", cls: ExcalidrawFreeDrawElement },
  { type: "image", cls: ExcalidrawImageElement },
  { type: "frame", cls: ExcalidrawFrameElement },
  { type: "magicframe", cls: ExcalidrawMagicFrameElement },
  { type: "embeddable", cls: ExcalidrawEmbeddableElement },
  { type: "iframe", cls: ExcalidrawIframeElement },
];

function stub(type: X.ExcalidrawElement["type"]): X.ExcalidrawElement {
  const base = {
    id: `el-${type}`,
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    angle: 0 as X.ExcalidrawRectangleElement["angle"],
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 2,
    strokeStyle: "solid" as const,
    roughness: 1,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 0,
    updated: 0,
    isDeleted: false,
    groupIds: [] as string[],
    frameId: null,
    boundElements: null,
    index: null,
    locked: false,
    link: null,
    roundness: null,
  };
  switch (type) {
    case "text":
      return {
        ...base,
        type,
        text: "hi",
        originalText: "hi",
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25 as X.ExcalidrawTextElement["lineHeight"],
      };
    case "line":
    case "arrow":
      return {
        ...base,
        type,
        points: [
          [0, 0],
          [10, 0],
        ],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: type === "arrow" ? "arrow" : null,
        ...(type === "arrow" ? { elbowed: false } : {}),
      } as X.ExcalidrawElement;
    case "freedraw":
      return {
        ...base,
        type,
        points: [
          [0, 0],
          [1, 1],
        ],
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
      };
    case "image":
      return {
        ...base,
        type,
        fileId: null,
        status: "pending",
        scale: [1, 1],
        crop: null,
      };
    case "frame":
    case "magicframe":
      return { ...base, type, name: "box" };
    case "iframe":
    case "embeddable":
    case "rectangle":
    case "diamond":
    case "ellipse":
    case "selection":
      return { ...base, type } as X.ExcalidrawElement;
  }
}

describe("element kinds", () => {
  it("spawns a real class for every document type", () => {
    const plexus = Plexus.bootstrap(new Scene());
    const scene = plexus.root as Scene;
    scene.ingest(KINDS.map((k) => stub(k.type)));
    const byType = new Map(scene.getNonDeletedElements().map((n) => [n.type, n]));
    for (const { type, cls } of KINDS) {
      expect(byType.get(type), type).toBeInstanceOf(cls);
    }
    const drawn = scene.getNonDeletedElements().map((n) => n.toJSON());
    expect(new Set(drawn.map((e) => e.type))).toEqual(new Set(KINDS.map((k) => k.type)));
    expect(drawn.every((e) => e.id === `el-${e.type}`)).toBe(true);
  });
});
