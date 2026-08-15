import { describe, expect, it } from "vitest";

import { PlexusSyncConfigError, UnknownLaneError, validateLaneDescriptors } from "../errors.js";

describe("validateLaneDescriptors", () => {
  it("throws PlexusSyncConfigError on empty lanes", () => {
    expect(() => validateLaneDescriptors([])).toThrow(PlexusSyncConfigError);
  });
});

describe("PlexusSyncError.invariant", () => {
  it("UnknownLaneError.invariant throws UnknownLaneError", () => {
    expect(() => UnknownLaneError.invariant(false, "test")).toThrow(UnknownLaneError);
  });
});