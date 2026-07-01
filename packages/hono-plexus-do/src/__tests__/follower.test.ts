import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { pushDiffToFollower } from "../follower.js";
import { regressFollowerSv } from "../follower.js";

describe("pushDiffToFollower", () => {
  it("encodes full state when horizon SV is empty", async () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("k", 1);
    const diffs: Uint8Array[] = [];
    const newSv = await pushDiffToFollower(doc, new Uint8Array(), {
      seed: async () => new Uint8Array(),
      applyDiff: (diff) => {
        diffs.push(diff);
        return new Uint8Array([9]);
      },
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.byteLength).toBeGreaterThan(0);
    expect(newSv).toEqual(new Uint8Array([9]));
  });
});

describe("regressFollowerSv", () => {
  it("detects follower state-vector shrinkage", () => {
    const prev = new Uint8Array([1, 2, 3, 4]);
    const grown = new Uint8Array([1, 2, 3, 4, 5]);
    const shrunk = new Uint8Array([1, 2]);
    expect(regressFollowerSv(prev, grown)).toBe(false);
    expect(regressFollowerSv(prev, shrunk)).toBe(true);
  });
});