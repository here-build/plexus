import { describe, expect, it } from "vitest";

import { mergeLocalSelect } from "./local-select.js";

describe("mergeLocalSelect", () => {
  it("applies select changes onto a graph snapshot that has no selected flag", () => {
    const snapshot = [
      { id: "a", label: "brief", selected: false },
      { id: "b", label: "hero", selected: false },
    ];
    const previous = [
      { id: "a", label: "brief", selected: true },
      { id: "b", label: "hero", selected: false },
    ];
    expect(
      mergeLocalSelect(snapshot, previous, [
        { type: "select", id: "a", selected: false },
        { type: "select", id: "b", selected: true },
        { type: "position", id: "b" },
      ]),
    ).toEqual([
      { id: "a", label: "brief", selected: false },
      { id: "b", label: "hero", selected: true },
    ]);
  });

  it("keeps previous selection when the graph changes without a select", () => {
    expect(
      mergeLocalSelect([{ id: "a" }, { id: "b" }], [{ id: "a", selected: true }], []),
    ).toEqual([
      { id: "a", selected: true },
      { id: "b", selected: false },
    ]);
  });
});
