# `@here.build/plexus-excalidraw-models`

Excalidraw's element types as Plexus models. The Scene is the document. The
element array is a view.

`@excalidraw/excalidraw` is a peer (types and the editor bag). This package
does not mount the editor.

Importing `Scene` loads every document type: `createElement` constructs them,
so `@syncing` registers them. There is no ambient register import.
