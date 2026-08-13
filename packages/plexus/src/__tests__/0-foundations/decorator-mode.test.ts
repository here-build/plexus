/**
 * Stage-2 compilers invoke `@syncing` as `(target, key)` or `(ctor)`.
 * Stage-3 passes a context object with `kind`. The throw is at the
 * decorator call — the two shapes are distinguishable without compiling
 * this file as legacy.
 */

import { describe, expect, it } from "vitest";

import { STAGE2_DECORATORS_UNSUPPORTED } from "../../decorator-mode.js";
import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";

@syncing("DecoratorModeRoot")
class Root extends PlexusModel {
  @syncing accessor name: string = "";

  @syncing.action
  touch() {
    this.name = "touched";
  }
}

describe("stage-3 decorator mode", () => {
  it("stage-3 decoration constructs", () => {
    expect(new Root({ name: "ok" }).name).to.equal("ok");
  });

  it("legacy class decorator call throws", () => {
    class Foo {}
    expect(() => (syncing as (name: string) => (ctor: unknown) => unknown)("LegacyClass")(Foo)).to.throw(
      STAGE2_DECORATORS_UNSUPPORTED,
    );
  });

  it("legacy field decorator call throws", () => {
    expect(() => (syncing as (target: object, key: string) => unknown)({}, "name")).to.throw(
      STAGE2_DECORATORS_UNSUPPORTED,
    );
  });

  it("legacy collection decorator call throws", () => {
    expect(() => (syncing.list as (target: object, key: string) => unknown)({}, "items")).to.throw(
      STAGE2_DECORATORS_UNSUPPORTED,
    );
  });

  it("legacy action decorator call throws", () => {
    expect(() => (syncing.action as (method: () => void) => unknown)(function method() {})).to.throw(
      STAGE2_DECORATORS_UNSUPPORTED,
    );
  });
});
