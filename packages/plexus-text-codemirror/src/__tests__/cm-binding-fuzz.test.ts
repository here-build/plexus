import { describe, expect, it } from "vitest";

import {
  applyRandomBindingTests,
  assertPeersAgree,
} from "./_helpers/binding-fuzz.js";

describe("Layer C — CodeMirror binding fuzz", () => {
  it("smoke: 2 peers × 30 steps converge", () => {
    const { peers, trace } = applyRandomBindingTests({ peers: 2, steps: 30, seed: 42 });
    try {
      assertPeersAgree(peers, "cm-smoke");
    } catch (e) {
      throw new Error(`${(e as Error).message}\ntrace=${JSON.stringify(trace)}`);
    }
    for (const p of peers) p.view.destroy();
  });

  it("medium: 3 peers × 70 steps converge", () => {
    const { peers, trace } = applyRandomBindingTests({ peers: 3, steps: 70, seed: 7 });
    try {
      assertPeersAgree(peers, "cm-medium");
    } catch (e) {
      throw new Error(`${(e as Error).message}\ntrace=${JSON.stringify(trace)}`);
    }
    for (const p of peers) p.view.destroy();
  });

  it("second seed smoke stays green", () => {
    const { peers } = applyRandomBindingTests({ peers: 2, steps: 30, seed: 99 });
    expect(() => assertPeersAgree(peers, "cm-smoke-99")).to.not.throw();
    for (const p of peers) p.view.destroy();
  });
});
