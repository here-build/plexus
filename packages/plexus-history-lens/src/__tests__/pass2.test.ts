import { describe, expect, it } from "vitest";

import { coordinateClause, pass2, type ResolvedChange } from "../pass2.js";

const el = (name: string): { kind: string; name: string } => ({ kind: "element", name });

describe("Pass 2 — facets-by-(object, coordinate) consolidation", () => {
  it("THE TARGET: many facets of one element under one pseudo-state → one gesture", () => {
    const changes: ResolvedChange[] = [
      { object: el("action button"), fragment: "additional click handler", coordinate: { kind: "pseudo-state", variants: ["hovered"] } },
      { object: el("action button"), fragment: "pointer cursor", coordinate: { kind: "pseudo-state", variants: ["hovered"] } },
      { object: el("action button"), fragment: "scale", coordinate: { kind: "pseudo-state", variants: ["hovered"] } },
    ];
    expect(pass2(changes)).toEqual(["action button gets additional click handler, pointer cursor, and scale when hovered"]);
  });

  it("splits groups by coordinate: same element, base vs danger → two lines", () => {
    const changes: ResolvedChange[] = [
      { object: el("card"), fragment: "rounded corners" }, // base combo → no clause
      { object: el("card"), fragment: "red border", coordinate: { kind: "component-state", variants: ["danger"] } },
    ];
    expect(pass2(changes)).toEqual(["card gets rounded corners", "card gets red border in the danger state"]);
  });

  it("typed-variance clauses dispatch on kind", () => {
    expect(coordinateClause({ kind: "pseudo-state", variants: ["hovered"] })).toBe(" when hovered");
    expect(coordinateClause({ kind: "environment", variants: ["dark mode"] })).toBe(" in dark mode");
    expect(coordinateClause({ kind: "component-state", variants: ["danger"] })).toBe(" in the danger state");
    expect(coordinateClause(undefined)).toBe(""); // base ⇒ no clause
  });

  it("natural-language facet list (a · a and b · a, b, and c)", () => {
    const one = pass2([{ object: el("x"), fragment: "padding" }]);
    const two = pass2([
      { object: el("y"), fragment: "padding" },
      { object: el("y"), fragment: "margin" },
    ]);
    expect(one).toEqual(["x gets padding"]);
    expect(two).toEqual(["y gets padding and margin"]);
  });
});
