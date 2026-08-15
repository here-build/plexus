import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { GENESIS_ORIGIN, MESSAGE_SYNC, REHYDRATE_ORIGIN } from "../constants.js";
import { shouldIgnoreUpdateOrigin } from "../persist.js";
import type { LaneDescriptor } from "../types.js";

describe("lane descriptors", () => {
  it("spawn docs from metadata-only descriptors", () => {
    const descriptors: LaneDescriptor[] = [
      { id: "prime", messageType: MESSAGE_SYNC, persistKey: "yjs-state" },
      { id: "comments", messageType: 2, persistKey: "yjs-state-comments", gc: true },
    ];
    const resolved = descriptors.map((d) => ({ ...d, doc: new Y.Doc({ gc: d.gc ?? true }) }));
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.doc).toBeInstanceOf(Y.Doc);
    expect(resolved[1]!.doc).not.toBe(resolved[0]!.doc);
  });

  it("treats genesis origin like rehydrate for listener suppression", () => {
    expect(shouldIgnoreUpdateOrigin(REHYDRATE_ORIGIN)).toBe(true);
    expect(shouldIgnoreUpdateOrigin(GENESIS_ORIGIN)).toBe(true);
    expect(shouldIgnoreUpdateOrigin("ws")).toBe(false);
  });
});