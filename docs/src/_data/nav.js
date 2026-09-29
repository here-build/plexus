export default [
  { label: "Overview", href: "/" },
  {
    label: "Getting started",
    items: [
      { label: "Installation", href: "/start/installation/" },
      { label: "From local to shared", href: "/start/first-model/" },
      { label: "Connecting clients", href: "/start/connecting-clients/" },
    ],
  },
  {
    label: "Guide",
    items: [
      { label: "Models and fields", href: "/guide/fields/" },
      { label: "Constructors and inheritance", href: "/laws/shape/" },
      { label: "Ownership and references", href: "/guide/ownership/" },
      { label: "Document lifecycle", href: "/laws/lifecycle/" },
      { label: "Reactivity and transactions", href: "/guide/time/" },
      { label: "Undo and redo", href: "/guide/undo/" },
      { label: "Presence and awareness", href: "/guide/awareness/" },
      { label: "Finding models", href: "/guide/find/" },
      { label: "Traversing a graph", href: "/guide/walk/" },
      { label: "Virtual maps", href: "/guide/virtual-maps/" },
      { label: "Errors and troubleshooting", href: "/guide/errors/" },
    ],
  },
  {
    label: "Examples",
    items: [
      { label: "Excalidraw", href: "/showcase/excalidraw/" },
      { label: "React Flow", href: "/showcase/xyflow/" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "API cheat sheet", href: "/api/" },
      { label: "Advanced model features", href: "/guide/goodies/" },
    ],
  },
  {
    label: "Internals",
    collapsed: true,
    items: [
      { label: "The seed rule", href: "/laws/seed/" },
      { label: "Two-doc routing", href: "/internals/routing/" },
      { label: "Append-only shells", href: "/internals/append-only-shells/" },
      { label: "Liminal grounding", href: "/internals/liminal-grounding/" },
      { label: "Awareness coherence", href: "/internals/awareness-coherence/" },
      { label: "Dependencies", href: "/internals/dependencies/" },
      { label: "Error handling", href: "/internals/error-handling/" },
      { label: "Telemetry", href: "/internals/telemetry/" },
    ],
  },
];
