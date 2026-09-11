import { Flow } from "./Flow.js";
import { FlowEdge } from "./FlowEdge.js";
import { FlowNode } from "./FlowNode.js";

const BOX = { width: 152, height: 56 };

function box(type: string, x: number, y: number, label: string): FlowNode {
  return new FlowNode({ type, x, y, label, ...BOX });
}

function group(x: number, y: number, width: number, height: number, label: string, children: FlowNode[]): FlowNode {
  return new FlowNode({ type: "group", x, y, width, height, label, children });
}

function pointer(source: FlowNode, target: FlowNode, label = ""): FlowEdge {
  const edge = new FlowEdge({ type: "smoothstep", label });
  edge.source = source;
  edge.target = target;
  return edge;
}

/**
 * First-writer graph. Studio owns board and kit; board and review are
 * separate owners. `handoff` is the cross-group pointer — deleting review
 * drops the edge, not the caption it pointed at.
 */
export function defaultFlow(): Flow {
  const hero = box("default", 28, 56, "hero");
  const caption = box("default", 28, 148, "caption");
  const mark = box("default", 28, 240, "mark");
  const board = group(20, 44, 400, 360, "board", [hero, caption, mark]);

  const type = box("default", 24, 56, "type");
  const color = box("default", 24, 148, "color");
  const lockup = box("default", 24, 240, "lockup");
  const kit = group(444, 44, 236, 360, "kit", [type, color, lockup]);

  const studio = group(220, 40, 704, 440, "studio", [board, kit]);

  const notes = box("default", 24, 56, "notes");
  const signOff = box("default", 24, 180, "sign-off");
  const review = group(964, 72, 248, 320, "review", [notes, signOff]);

  const brief = box("input", 24, 220, "brief");
  const ship = box("output", 1256, 220, "ship");

  const art = pointer(brief, hero);
  const through = pointer(hero, caption);
  const lock = pointer(caption, mark);
  const setType = pointer(type, caption);
  const setColor = pointer(color, mark);
  const handoff = pointer(caption, notes, "handoff");
  const approve = pointer(notes, signOff);
  const out = pointer(signOff, ship);

  return new Flow({
    children: [brief, studio, review, ship],
    edgeList: [art, through, lock, setType, setColor, handoff, approve, out],
    nodes: new Map([
      ["n-brief", brief],
      ["n-studio", studio],
      ["n-board", board],
      ["n-hero", hero],
      ["n-caption", caption],
      ["n-mark", mark],
      ["n-kit", kit],
      ["n-type", type],
      ["n-color", color],
      ["n-lockup", lockup],
      ["n-review", review],
      ["n-notes", notes],
      ["n-signoff", signOff],
      ["n-ship", ship],
    ]),
    edges: new Map([
      ["e-brief-hero", art],
      ["e-hero-caption", through],
      ["e-caption-mark", lock],
      ["e-type-caption", setType],
      ["e-color-mark", setColor],
      ["e-caption-notes", handoff],
      ["e-notes-signoff", approve],
      ["e-signoff-ship", out],
    ]),
  });
}
