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

  it("keeps measured across snapshots so a resize does not start from 0", () => {
    const previous = [{ id: "a", width: 248, height: 320, measured: { width: 248, height: 320 }, selected: true }];
    expect(mergeLocalSelect([{ id: "a", width: 248, height: 320 }], previous, [])).toEqual([
      { id: "a", width: 248, height: 320, selected: true, measured: { width: 248, height: 320 } },
    ]);
    expect(
      mergeLocalSelect([{ id: "a", width: 300, height: 360 }], previous, [
        { type: "dimensions", id: "a", dimensions: { width: 300, height: 360 } },
      ]),
    ).toEqual([{ id: "a", width: 300, height: 360, selected: true, measured: { width: 300, height: 360 } }]);
  });

  it("seeds measured from the model size when the editor has not measured yet", () => {
    expect(mergeLocalSelect([{ id: "a", width: 152, height: 56 }], [], [])).toEqual([
      { id: "a", width: 152, height: 56, selected: false, measured: { width: 152, height: 56 } },
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
