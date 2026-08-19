import {Excalidraw as ExcalidrawEditor} from "@excalidraw/excalidraw";
import type {ExcalidrawImperativeAPI, ExcalidrawProps} from "@excalidraw/excalidraw/types";
import {useEffect, useRef, useState} from "react";

import {bindExcalidraw} from "./bind.js";
import type {ExcalidrawPlexus} from "./ExcalidrawPlexus.js";
import {useMergedInitial} from "./hooks/useMergedInitial.js";

export type PlexusExcalidrawProps = ExcalidrawProps & {
  plexus: ExcalidrawPlexus;
};

/**
 * Drop-in `<Excalidraw>` bound to a Scene. Children (`MainMenu`, `Footer`,
 * `Sidebar`, `DiagramToCodePlugin`, …) mount inside the real editor and keep
 * their context. `initialData.elements` / `files` come from the graph; other
 * initialData (appState, scrollToContent) still merges in.
 */
export function Excalidraw({
  plexus,
  children,
  excalidrawAPI,
  onChange,
  initialData,
  ...rest
}: PlexusExcalidrawProps) {
  const scene = plexus.root;
  const [api, setApiState] = useState<ExcalidrawImperativeAPI | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const userApiRef = useRef(excalidrawAPI);
  userApiRef.current = excalidrawAPI;

  useEffect(() => {
    if (!api) return;
    return bindExcalidraw(scene, api, plexus, (...args) => onChangeRef.current?.(...args));
  }, [api, scene, plexus]);

  const mergedInitial = useMergedInitial(scene, initialData);

  return (
    <ExcalidrawEditor
        {...rest}
        initialData={mergedInitial}
        excalidrawAPI={(next: ExcalidrawImperativeAPI) => {
          setApiState(next);
          userApiRef.current?.(next);
        }}>
      {children}
    </ExcalidrawEditor>
  );
}
