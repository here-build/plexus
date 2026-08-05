import { syncing } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import { ExpectationActor, ExpectationLoader, type LaunchContext } from "../executor/index.js";
import {
  Expectation,
  LaunchDefinition,
  type ExpectationOf,
  type InputOf,
  type IntentOf,
  type ReportOf,
  type ResultOf,
} from "../shared/index.js";

/**
 * Triad typing: the Expectation subclass is the single type carrier —
 * input, report, result, and handleable intents — and loader/actor/definition
 * are implementations OF that contract (`ExpectationLoader<E>` etc.).
 * All assertions here are compile-time; the runtime test only proves the
 * phantom intent declaration leaves no residue on the wire model.
 */

type DemoInput = { readonly seed: string };
type DemoReport = { readonly note: string };
type DemoResult = { readonly value: number };
type DemoIntent = { readonly kind: "steer"; readonly gain: number };

@syncing("test:TriadDemoExpectation")
class DemoExpectation extends Expectation<DemoResult, DemoReport, DemoIntent> {
  static override readonly kind: string = "test.triad.demo";

  override snapshotInput(): DemoInput {
    return { seed: "s" };
  }

  override applySettlement(_result: DemoResult): void {}
}

@syncing("test:TriadPlainExpectation")
class PlainExpectation extends Expectation<void, { readonly done: boolean }> {
  static override readonly kind: string = "test.triad.plain";
}

@syncing("test:TriadDemoDefinition")
class DemoDefinition extends LaunchDefinition<DemoExpectation> {}

// --- compile-time assertions -------------------------------------------------

// Tuple-wrapped so `never` compares without distributing away.
type Is<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const inputCarried: Is<InputOf<DemoExpectation>, DemoInput> = true;
const reportCarried: Is<ReportOf<DemoExpectation>, DemoReport> = true;
const resultCarried: Is<ResultOf<DemoExpectation>, DemoResult> = true;
const intentCarried: Is<IntentOf<DemoExpectation>, DemoIntent> = true;
// Undeclared intents default to never: unsteerable at compile time.
const plainUnsteerable: Is<IntentOf<PlainExpectation>, never> = true;
// The definition declares which expectation it launches.
const definitionBound: Is<ExpectationOf<DemoDefinition>, DemoExpectation> = true;
// Intent-carrying subclasses still flow through kernel surfaces typed `Expectation`.
const kernelCompatible: Expectation = new DemoExpectation();

class DemoActor extends ExpectationActor<DemoExpectation> {
  protected override run(ctx: LaunchContext<DemoExpectation>): void {
    // Typed membrane: no `ctx.input as ...` casts on the far side of spawn.
    const seed: string = ctx.input.seed;
    const entry = ctx.mailbox.entries[0];
    if (entry) {
      const gain: number = entry.body.gain;
      void gain;
    }
    this.report({ note: seed });
    // @ts-expect-error report frames are ReportOf<DemoExpectation>
    this.report({ wrong: true });
    this.complete({ value: 1 });
    // @ts-expect-error settlement must match the declared result shape
    this.complete("nope");
  }
}

class DemoLoader extends ExpectationLoader<DemoExpectation> {
  override async load(): Promise<void> {}

  protected override createActor(ctx: LaunchContext<DemoExpectation>): ExpectationActor<DemoExpectation> {
    void ctx;
    return new DemoActor();
  }
}

void [inputCarried, reportCarried, resultCarried, intentCarried, plainUnsteerable, definitionBound];
void kernelCompatible;
void DemoLoader;

describe("triad typing", () => {
  it("the phantom intent declaration leaves no runtime residue", () => {
    const E = new DemoExpectation();
    expect("__intent__" in E).toBe(false);
    expect(E.snapshotInput()).toEqual({ seed: "s" });
  });
});
