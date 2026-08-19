import { describe, expect, it } from "vitest";

import {
  applyRandomBindingTests,
  assertPeersAgree,
} from "./_helpers/binding-fuzz.js";

describe("Layer C — Lexical binding fuzz", () => {
  it("smoke: 2 peers × 30 steps converge (text + bold)", () => {
    const { peers, trace } = applyRandomBindingTests({ peers: 2, steps: 30, seed: 42 });
    try {
      assertPeersAgree(peers, "lex-smoke");
    } catch (e) {
      throw new Error(`${(e as Error).message}\ntrace=${JSON.stringify(trace)}`);
    }
    for (const p of peers) p.unbind();
  });

  it("medium: 3 peers × 70 steps converge", () => {
    const { peers, trace } = applyRandomBindingTests({ peers: 3, steps: 70, seed: 7 });
    try {
      assertPeersAgree(peers, "lex-medium");
    } catch (e) {
      throw new Error(`${(e as Error).message}\ntrace=${JSON.stringify(trace)}`);
    }
    for (const p of peers) p.unbind();
  });

  it("second seed smoke stays green", () => {
    const { peers } = applyRandomBindingTests({ peers: 2, steps: 30, seed: 99 });
    expect(() => assertPeersAgree(peers, "lex-smoke-99")).to.not.throw();
    for (const p of peers) p.unbind();
  });
});
