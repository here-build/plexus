import type { ComboKey } from "@here.build/plexus-history";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { coordinateClause } from "../pass2.js";
import { resolveVarianceCoord, varianceKindOf, variantSubjectType } from "../variance.js";

const setCombo = (uuids: string[]): ComboKey => ({ kind: "set", members: uuids.map((uuid) => ({ ref: { uuid, type: "Variant" } })) });

describe("varianceKindOf — VariantGroup.subject type → variance kind", () => {
  it("maps each subject type (cited to the model source)", () => {
    expect(varianceKindOf("State")).toBe("component-state");
    expect(varianceKindOf("ElementEnvironment")).toBe("pseudo-state");
    expect(varianceKindOf("MediaEnvironment")).toBe("environment");
    expect(varianceKindOf("RouterEnvironment")).toBe("environment");
    expect(varianceKindOf("Environment")).toBe("environment");
    expect(varianceKindOf("CustomCode")).toBe("condition");
  });
  it("unknown / null subject → condition (the safe generic predicate)", () => {
    expect(varianceKindOf(null)).toBe("condition");
    expect(varianceKindOf("SomethingNew")).toBe("condition");
  });
});

describe("resolveVarianceCoord — parsed combo → typed coordinate (pure: nameOf + subjectTypeOf injected)", () => {
  const nameOf = (u: string): string | undefined => ({ "v-danger": "danger", "v-hover": "hovered", "v-loading": "loading" })[u];
  const subjectTypeOf = (u: string): string | null => ({ "v-danger": "State", "v-hover": "ElementEnvironment", "v-loading": "State" })[u] ?? null;

  it("single State variant → component-state", () => {
    expect(resolveVarianceCoord(setCombo(["v-danger"]), nameOf, subjectTypeOf)).toEqual({ kind: "component-state", variants: ["danger"] });
  });
  it("single ElementEnvironment variant → pseudo-state", () => {
    expect(resolveVarianceCoord(setCombo(["v-hover"]), nameOf, subjectTypeOf)).toEqual({ kind: "pseudo-state", variants: ["hovered"] });
  });
  it("empty (base) combo → null — no clause", () => {
    expect(resolveVarianceCoord({ kind: "set", members: [] }, nameOf, subjectTypeOf)).toBeNull();
  });
  it("non-Set combo → null", () => {
    expect(resolveVarianceCoord({ kind: "value", members: [{ value: "x" }] }, nameOf, subjectTypeOf)).toBeNull();
  });
  it("multi-axis combo → FIRST variant's kind, all names (mixed-kind phrasing is the open edge)", () => {
    expect(resolveVarianceCoord(setCombo(["v-danger", "v-loading"]), nameOf, subjectTypeOf)).toEqual({
      kind: "component-state",
      variants: ["danger", "loading"],
    });
  });
  it("unknown variant → name falls back to uuid, kind to condition", () => {
    expect(resolveVarianceCoord(setCombo(["v-mystery"]), nameOf, subjectTypeOf)).toEqual({ kind: "condition", variants: ["v-mystery"] });
  });

  it("THE PAYOFF: composes with pass2's coordinateClause → the human clause", () => {
    expect(coordinateClause(resolveVarianceCoord(setCombo(["v-danger"]), nameOf, subjectTypeOf)!)).toBe(" in the danger state");
    expect(coordinateClause(resolveVarianceCoord(setCombo(["v-hover"]), nameOf, subjectTypeOf)!)).toBe(" when hovered");
  });
});

describe("variantSubjectType — the live archive walk (variant → group → subject)", () => {
  it("returns null for a variant absent from the archive (the walk's defensive base)", () => {
    // The real-model proof (a true VariantGroup) lives in core's combo-key.test.ts — this is the
    // empty-chain guard; the lens has no model dep to construct a VariantGroup here.
    expect(variantSubjectType(new Y.Doc(), "not-in-doc")).toBeNull();
  });
});
