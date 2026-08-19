import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { snapshotFiles, type Scene } from "@here.build/plexus-excalidraw-models";
import { useMemo } from "react";

import { snapshot } from "../snapshot.js";

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>).then === "function";
}

export function useMergedInitial(
  scene: Scene,
  initialData: ExcalidrawProps["initialData"],
): ExcalidrawProps["initialData"] {
  return useMemo(() => {
    const ours = {
      elements: snapshot(scene),
      files: Object.fromEntries(snapshotFiles(scene).map((file) => [file.id, file])),
    };
    if (initialData == null) return ours;
    if (typeof initialData === "function") {
      return async () => {
        const user = await initialData();
        return { ...user, ...ours, appState: user?.appState };
      };
    }
    if (isThenable(initialData)) {
      return Promise.resolve(initialData).then((user) => ({
        ...user,
        ...ours,
        appState: user?.appState,
      }));
    }
    return { ...initialData, ...ours, appState: initialData.appState };
  }, [scene, initialData]);
}
