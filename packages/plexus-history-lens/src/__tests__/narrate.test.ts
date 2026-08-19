import { describe, expect, it } from "vitest";

import { behaviorArea } from "../areas/behavior.js";
import { stylingArea } from "../areas/styling.js";
import { humanizeOne } from "../humanize.js";
import { narrate } from "../narrate.js";
import type { IntentEvent } from "../types.js";
import type { VarianceCoord } from "../variance.js";

/*
 * Pass 2 composed end-to-end at the lens layer (lens-architecture.md §4): `narrate(IntentEvent[])` over
 * PRE-STAMPED events (the `object`/`coordinate` the live pipeline attaches via `resolveChange` — here supplied
 * directly, so this is archive-free and pure). Proves the routing: facet-events fold into `(object,
 * coordinate)` gestures; subject-events pass through `humanize`; order + accretion are first-appearance.
 * The full archive-backed wiring (real model → consolidate(archive) → narrate) is the e2e capstone.
 */

const base = (seq: number): Pick<IntentEvent, "seq" | "timestamp" | "author" | "sourceUuids"> => ({
  seq,
  timestamp: seq,
  author: null,
  sourceUuids: [],
});
const hovered: VarianceCoord = { kind: "pseudo-state", variants: ["hovered"] };
const danger: VarianceCoord = { kind: "component-state", variants: ["danger"] };
const btn = { uuid: "uBtn", type: "TplTag", name: "button" };
const card = { uuid: "uCard", type: "TplTag", name: "card" };

describe("narrate — Pass 2 composition (facet gestures + subject lines)", () => {
  it("THE FLAGSHIP: many facets of one element under one pseudo-state → one gesture", () => {
    const events: IntentEvent[] = [
      { kind: "BehaviorAdded", handlerKind: "event", targetLabel: "button", object: btn, coordinate: hovered, ...base(0) },
      { kind: "StylePropertyChanged", propConcept: "cursor", op: "set", object: btn, coordinate: hovered, ...base(0) },
      { kind: "StylePropertyChanged", propConcept: "scale", op: "set", object: btn, coordinate: hovered, ...base(0) },
    ];
    expect(narrate(events)).toEqual(["button gets a handler, cursor, and scale when hovered"]);
  });

  it("the capstone gesture: a style under the danger component-state reads 'in the danger state'", () => {
    const events: IntentEvent[] = [
      { kind: "StylePropertyChanged", propConcept: "background", op: "set", object: btn, coordinate: danger, ...base(0) },
    ];
    expect(narrate(events)).toEqual(["button gets background in the danger state"]);
  });

  it("splits groups by coordinate: same element, base vs danger → two gestures", () => {
    const events: IntentEvent[] = [
      { kind: "StylePropertyChanged", propConcept: "corner radius", op: "set", object: card, ...base(0) }, // base ⇒ no clause
      { kind: "StylePropertyChanged", propConcept: "border", op: "set", object: card, coordinate: danger, ...base(0) },
    ];
    expect(narrate(events)).toEqual(["card gets corner radius", "card gets border in the danger state"]);
  });

  it("subject events pass through humanize, interleaved; facets accrete into their first-appearance slot", () => {
    const events: IntentEvent[] = [
      { kind: "ComponentAdded", componentType: "component", name: "Card", ...base(0) }, // subject → standalone line
      { kind: "StylePropertyChanged", propConcept: "background", op: "set", object: btn, coordinate: danger, ...base(1) }, // group anchor
      { kind: "ComponentRenamed", from: "Old", to: "New", ...base(2) }, // subject line BETWEEN the two facets
      { kind: "StylePropertyChanged", propConcept: "border", op: "set", object: btn, coordinate: danger, ...base(3) }, // accretes into the anchor
    ];
    expect(narrate(events)).toEqual([
      `Added component "Card"`,
      "button gets background and border in the danger state",
      `Renamed component "Old" → "New"`,
    ]);
  });

  it("a non-additive facet (cleared) does NOT fold into 'gets' — it renders standalone via humanize", () => {
    const cleared: IntentEvent = { kind: "StylePropertyChanged", propConcept: "background", op: "cleared", object: btn, coordinate: danger, ...base(0) };
    expect(narrate([cleared])).toEqual([humanizeOne(cleared)]); // = "cleared background", not a gesture
  });
});

describe("area fragments (the Pass-2 facet phrase — the dual of humanize)", () => {
  it("styling: an additive acquisition → a noun; a non-additive edit / a foreign kind → null", () => {
    expect(stylingArea.fragment!({ kind: "StylePropertyChanged", propConcept: "background", op: "set", ...base(0) })).toBe("background");
    expect(stylingArea.fragment!({ kind: "StylePropertyChanged", propConcept: "background", op: "changed", ...base(0) })).toBe("background");
    expect(stylingArea.fragment!({ kind: "StylePropertyChanged", propConcept: "background", op: "cleared", ...base(0) })).toBeNull();
    expect(stylingArea.fragment!({ kind: "LayerChanged", layer: "shadow", op: "added", ...base(0) })).toBe("a shadow");
    expect(stylingArea.fragment!({ kind: "LayerChanged", layer: "shadow", op: "removed", ...base(0) })).toBeNull();
    expect(stylingArea.fragment!({ kind: "ComponentAdded", componentType: "component", name: "X", ...base(0) })).toBeNull(); // not styling's kind
  });

  it("behavior: a handler/step added → a noun; edits + removal → null", () => {
    expect(behaviorArea.fragment!({ kind: "BehaviorAdded", handlerKind: "event", targetLabel: "btn", ...base(0) })).toBe("a handler");
    expect(behaviorArea.fragment!({ kind: "BehaviorAdded", handlerKind: "event", targetLabel: "btn", event: "onClick", ...base(0) })).toBe("a onClick handler");
    expect(behaviorArea.fragment!({ kind: "BehaviorAdded", handlerKind: "reactive", targetLabel: "btn", ...base(0) })).toBe("a reactive handler");
    expect(behaviorArea.fragment!({ kind: "InteractionStepChanged", subKind: "added", label: "step 1", ...base(0) })).toBe("an interaction step");
    expect(behaviorArea.fragment!({ kind: "InteractionStepChanged", subKind: "renamed", label: "step 1", ...base(0) })).toBeNull();
    expect(behaviorArea.fragment!({ kind: "BehaviorRemoved", handlerKind: "event", targetLabel: "btn", ...base(0) })).toBeNull();
  });
});
