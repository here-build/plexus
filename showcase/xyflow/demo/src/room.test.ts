import { describe, expect, it } from "vitest";

import { resolveRoom } from "./room.js";

describe("resolveRoom", () => {
  it("keeps an existing room", () => {
    const resolved = resolveRoom("https://demo.test/xyflow?room=checkout", () => "minted");
    expect(resolved).toEqual({ room: "checkout", search: "?room=checkout", assigned: false });
  });

  it("assigns when the URL has no room — the href is the invite", () => {
    const resolved = resolveRoom("https://demo.test/xyflow", () => "flow-aa11");
    expect(resolved.assigned).toBe(true);
    expect(resolved.room).toBe("flow-aa11");
    expect(resolved.search).toBe("?room=flow-aa11");
  });
});
