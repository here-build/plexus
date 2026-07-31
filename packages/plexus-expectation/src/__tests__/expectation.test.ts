import "@here.build/plexus/mobx/register";

import { PlexusModel, resetLocalIDs, syncing } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assertCloneable,
  Expectation,
  PewCloneOpenError,
  PewTerminalWriteError,
  type Lifecycle,
} from "../app/index.js";

@syncing("@here.build/plexus-expectation:test.Expectation")
class TestExpectation extends Expectation {
  static readonly kind = "test.expectation";
}

/** Minimal forest owner so children can adopt under a root if needed. */
@syncing("@here.build/plexus-expectation:test.Forest")
class TestForest extends PlexusModel {
  @syncing.child.list accessor openWork: TestExpectation[] = [];
}

function openExpectation(state: Lifecycle = "declared"): TestExpectation {
  return new TestExpectation({
    state,
    bindEpoch: 0,
    rebindCount: 0,
    children: [],
  });
}

describe("Expectation", () => {
  beforeEach(() => resetLocalIDs());

  it("defaults: declared, epoch 0, rebindCount 0, empty children", () => {
    const e = new TestExpectation();
    expect(e.state).toBe("declared");
    expect(e.bindEpoch).toBe(0);
    expect(e.rebindCount).toBe(0);
    expect(e.children).toEqual([]);
    expect(e.kind).toBe("test.expectation");
    expect(TestExpectation.kind).toBe("test.expectation");
  });

  describe("terminal write barrier", () => {
    it("refuses leaving sealed | failed | cancelled", () => {
      for (const terminal of ["sealed", "failed", "cancelled"] as const) {
        const e = openExpectation(terminal);
        expect(() => e.transitionState("declared")).toThrow(PewTerminalWriteError);
        expect(() => e.transitionState("running")).toThrow(PewTerminalWriteError);
        expect(e.state).toBe(terminal);
      }
    });

    it("same-state transition is a no-op", () => {
      const e = openExpectation("sealed");
      expect(() => e.transitionState("sealed")).not.toThrow();
      expect(e.state).toBe("sealed");
    });

    it("allows open → open and open → terminal", () => {
      const e = openExpectation("declared");
      e.transitionState("running");
      expect(e.state).toBe("running");
      e.transitionState("sealed");
      expect(e.state).toBe("sealed");
      expect(() => e.transitionState("cancelled")).toThrow(PewTerminalWriteError);
    });
  });

  describe("clone (T11)", () => {
    it("T11: open (non-terminal) clone throws PewCloneOpenError", () => {
      for (const state of ["declared", "missing", "refused", "running", "awaiting_rebind"] as const) {
        const e = openExpectation(state);
        expect(() => e.clone()).toThrow(PewCloneOpenError);
        expect(() => assertCloneable(e)).toThrow(PewCloneOpenError);
      }
    });

    it("terminal clone succeeds and resets bindEpoch / rebindCount", () => {
      const e = new TestExpectation({
        state: "sealed",
        bindEpoch: 7,
        rebindCount: 3,
        children: [],
      });
      const cloned = e.clone();
      expect(cloned).not.toBe(e);
      expect(cloned.state).toBe("sealed");
      expect(cloned.bindEpoch).toBe(0);
      expect(cloned.rebindCount).toBe(0);
      // source unchanged
      expect(e.bindEpoch).toBe(7);
      expect(e.rebindCount).toBe(3);
    });

    it("assertCloneable walks children — open child under terminal parent throws", () => {
      const child = openExpectation("running");
      const parent = new TestExpectation({
        state: "sealed",
        bindEpoch: 1,
        rebindCount: 0,
        children: [child],
      });
      expect(() => assertCloneable(parent)).toThrow(PewCloneOpenError);
      expect(() => parent.clone()).toThrow(PewCloneOpenError);
    });

    it("terminal parent + terminal children clone resets each node", () => {
      const child = new TestExpectation({
        state: "failed",
        bindEpoch: 2,
        rebindCount: 1,
        children: [],
      });
      const parent = new TestExpectation({
        state: "cancelled",
        bindEpoch: 9,
        rebindCount: 4,
        children: [child],
      });
      const cloned = parent.clone();
      expect(cloned.bindEpoch).toBe(0);
      expect(cloned.rebindCount).toBe(0);
      expect(cloned.children).toHaveLength(1);
      const c0 = cloned.children[0]!;
      expect(c0.state).toBe("failed");
      expect(c0.bindEpoch).toBe(0);
      expect(c0.rebindCount).toBe(0);
    });
  });

  it("forest owner can hold openWork list of expectations", () => {
    const forest = new TestForest({
      openWork: [openExpectation("declared"), openExpectation("running")],
    });
    expect(forest.openWork).toHaveLength(2);
    expect(forest.openWork[0]!.kind).toBe("test.expectation");
  });
});
