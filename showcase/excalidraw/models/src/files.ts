import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

import { ExcalidrawFile } from "./ExcalidrawFile.js";
import type { Scene } from "./Scene.js";

export function applyFiles(scene: Scene, files: BinaryFiles): void {
  for (const data of Object.values(files)) {
    let node = scene.files.get(data.id);
    if (!node) {
      node = new ExcalidrawFile();
      scene.files.set(data.id, node);
    }
    node.mimeType = data.mimeType;
    node.dataURL = data.dataURL;
    node.created = data.created;
    node.lastRetrieved = data.lastRetrieved ?? null;
  }
}

export function snapshotFiles(scene: Scene): BinaryFileData[] {
  return scene.files
    .values()
    .filter((f) => f.fileId && f.dataURL)
    .map((f) => ({
      id: f.fileId as BinaryFileData["id"],
      mimeType: f.mimeType as BinaryFileData["mimeType"],
      dataURL: f.dataURL as BinaryFileData["dataURL"],
      created: f.created,
      ...(f.lastRetrieved != null ? { lastRetrieved: f.lastRetrieved } : {}),
    }))
    .toArray();
}
