import { describe, expect, it } from "vitest";

import { hrefWithView, isPeerView } from "./view.js";

describe("view", () => {
  it("detects the peer pane", () => {
    expect(isPeerView("?room=flow-1&view=peer")).toBe(true);
    expect(isPeerView("?room=flow-1")).toBe(false);
  });

  it("builds an invite without the peer flag, and a peer href with it", () => {
    const live = "https://demo.test/xyflow?room=flow-1";
    expect(hrefWithView(live, "peer")).toBe("https://demo.test/xyflow?room=flow-1&view=peer");
    expect(hrefWithView(`${live}&view=peer`, null)).toBe(live);
  });
});
