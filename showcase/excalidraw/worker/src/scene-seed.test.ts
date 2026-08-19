import { Plexus } from "@here.build/plexus";
import { ExcalidrawFrameElement, Scene } from "@here.build/plexus-excalidraw-models";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeSceneSeed } from "./scene-seed.js";

describe("encodeSceneSeed", () => {
  it("is a document a peer can connect to — not a second bootstrap", () => {
    const guid = "room-1";
    const bytes = encodeSceneSeed(guid);
    const doc = new Y.Doc({ guid });
    Y.applyUpdate(doc, bytes);

    const plexus = Plexus.connect(doc);
    const scene = plexus.root as Scene;
    expect(scene.children).toHaveLength(3);
    expect(scene.children.some((n) => n instanceof ExcalidrawFrameElement)).toBe(true);
    doc.destroy();
  });
});
