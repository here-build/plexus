# `@here.build/plexus-xyflow-models`

xyflow's node and edge types as Plexus models. The Flow is the document. The
`nodes` / `edges` arrays are a view.

`@xyflow/react` is a peer (types and the editor bag). This package does not
mount the canvas.

Importing `Flow` loads `FlowNode` and `FlowEdge`, so `@syncing` registers
them. There is no ambient register import.
