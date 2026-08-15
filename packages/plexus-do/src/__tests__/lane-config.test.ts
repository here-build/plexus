import { describe, expect, it } from "vitest";

import { MESSAGE_COMMENTS_SYNC, MESSAGE_SYNC } from "../constants.js";
import { PlexusSyncConfigError, validateLaneDescriptors } from "../errors.js";

describe("validateLaneDescriptors", () => {
  it("accepts a valid prime + comments layout", () => {
    expect(() =>
      validateLaneDescriptors([
        { id: "prime", messageType: MESSAGE_SYNC, persistKey: "yjs-state" },
        { id: "comments", messageType: MESSAGE_COMMENTS_SYNC, persistKey: "yjs-state-comments" },
      ]),
    ).not.toThrow();
  });

  it("rejects empty lanes", () => {
    expect(() => validateLaneDescriptors([])).toThrow(PlexusSyncConfigError);
  });

  it("rejects non-prime first lane", () => {
    expect(() =>
      validateLaneDescriptors([{ id: "comments", messageType: MESSAGE_COMMENTS_SYNC, persistKey: "c" }]),
    ).toThrow(/prime/);
  });

  it("rejects duplicate messageType", () => {
    expect(() =>
      validateLaneDescriptors([
        { id: "prime", messageType: MESSAGE_SYNC, persistKey: "a" },
        { id: "other", messageType: MESSAGE_SYNC, persistKey: "b" },
      ]),
    ).toThrow(/messageType/);
  });
});