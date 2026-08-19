import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { snapshotFiles, type Scene } from "@here.build/plexus-excalidraw-models";
import { reaction, runInAction } from "mobx";

import type { ExcalidrawPlexus } from "./ExcalidrawPlexus.js";
import { snapshot, stampEditorVersions, type EditorVersionState } from "./snapshot.js";

function elementsSig(elements: readonly { id: string; version: number }[]): string {
  return elements.map((el) => `${el.id}:${el.version}`).join(",");
}

/**
 * Excalidraw as a view of a Plexus Scene.
 *
 * Graph → editor is a MobX reaction whose data function only reads.
 * Costume versions are stamped in the effect. `applying` is I/O reentrancy
 * against Excalidraw's `onChange`, not a change detector.
 */
export function bindExcalidraw(
  scene: Scene,
  api: ExcalidrawImperativeAPI,
  plexus: ExcalidrawPlexus,
  onChange?: ExcalidrawProps["onChange"],
): () => void {
  let applying = false;
  let lastElements = "";
  let seenEditorContent = snapshot(scene).length > 0;
  const versions: EditorVersionState = new Map();

  const chord = (event: KeyboardEvent | { ctrlKey?: boolean; metaKey?: boolean; key: string }) =>
    Boolean(event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";

  api.registerAction({
    name: "undo",
    label: "undo",
    trackEvent: { category: "history" },
    keyPriority: 100,
    keyTest: (event) => chord(event) && !event.shiftKey,
    perform: () => {
      plexus.undo();
      return false;
    },
  });
  api.registerAction({
    name: "redo",
    label: "redo",
    trackEvent: { category: "history" },
    keyPriority: 100,
    keyTest: (event) =>
      (chord(event) && event.shiftKey) ||
      Boolean((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y"),
    perform: () => {
      plexus.redo();
      return false;
    },
  });

  const push = (
    elements: ReturnType<typeof snapshot>,
    files: ReturnType<typeof snapshotFiles>,
  ) => {
    const stamped = stampEditorVersions(elements, versions);
    api.updateScene({
      elements: stamped,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    if (files.length) api.addFiles(files);
    api.history.clear();
    return stamped;
  };

  const fromGraph = reaction(
    () => ({ elements: snapshot(scene), files: snapshotFiles(scene) }),
    ({ elements, files }) => {
      if (applying) return;
      applying = true;
      try {
        lastElements = elementsSig(push(elements, files));
      } finally {
        applying = false;
      }
    },
  );

  const fromEditor = api.onChange((elements, appState, files) => {
    if (applying) return;
    if (elements.length === 0 && !seenEditorContent) return;
    if (elements.length > 0) seenEditorContent = true;
    const sig = elementsSig(elements);
    if (sig === lastElements) {
      onChange?.(elements as never, appState, files);
      return;
    }
    lastElements = sig;
    applying = true;
    try {
      runInAction(() => {
        scene.applyEditor(elements, files);
      });
      api.history.clear();
    } finally {
      applying = false;
    }
    onChange?.(elements as never, appState, files);
  });

  applying = true;
  try {
    lastElements = elementsSig(push(snapshot(scene), snapshotFiles(scene)));
  } finally {
    applying = false;
  }

  return () => {
    fromGraph();
    fromEditor();
  };
}
